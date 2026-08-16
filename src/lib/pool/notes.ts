import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import {
  commitmentOf,
  noteAt,
  nullifierHashOf,
  precommitmentOf,
  type NoteSecret,
  type PoolKeys,
} from './keys';

/**
 * Finding a trader's money in a pool that has no idea who they are.
 *
 * ## The problem, stated honestly
 *
 * The pool stores commitments. A commitment is a hash, and there is no field in it, no event
 * anywhere, and no index on any server that says whose it is — that is the entire product. So a
 * client that wants to know its own balance cannot look it up. It has to *guess and check*: derive
 * the notes it would have created, and see which of those the chain happens to contain.
 *
 * That sounds fragile and is not, because the derivation is total. Deposit `i` publishes
 * `Poseidon(nullifier_i, secret_i)` in the clear, so recognising it is one hash and one lookup. And
 * a spend publishes `Poseidon(nullifier)`, so following a lineage forward is the same move again.
 *
 * ## The walk
 *
 * For each deposit index, oldest first:
 *
 *   1. compute the precommitment and look for it among the deposit leaves — no match, no deposit;
 *   2. on a match, walk the lineage: hash the note's nullifier, look for a withdrawal that spent
 *      it, and if one exists the remainder is a new note whose keys are the next in the sequence;
 *   3. stop when a note has not been spent. That note is the balance.
 *
 * The scan stops after {@link GAP_LIMIT} consecutive misses. A gap is possible — a deposit
 * transaction that reverted burns an index — and unbounded scanning would mean an unbounded loop
 * over every load.
 *
 * ## The one thing this deliberately does not do
 *
 * It never asks the backend which notes are ours, and there is no endpoint that could answer. An
 * authenticated "my notes" call would put the trader↔note mapping in our logs, which is precisely
 * the join the pool exists to destroy, and it would be the easiest copy of it to subpoena.
 */

/** How many empty deposit slots to look past before concluding there are no more. */
export const GAP_LIMIT = 8;

/** A leaf as `/pool/state` serves it. Every field is already public on chain. */
export interface PoolLeaf {
  index: number;
  kind: 'DEPOSIT' | 'CHANGE';
  commitment: string;
  label: string | null;
  value: string;
  precommitment: string | null;
  spentNullifier: string | null;
}

/** A note the trader owns and has not spent. */
export interface OwnedNote {
  readonly secret: NoteSecret;
  /** What it is worth, base units. */
  readonly value: bigint;
  /** The lineage's association label, inherited from the deposit that started it. */
  readonly label: bigint;
  /** The leaf itself. */
  readonly commitment: bigint;
  /** Where it sits in the state tree. Needed for the Merkle path, and only valid for this state. */
  readonly stateIndex: number;
}

export interface RecoveredNotes {
  /** Spendable notes, largest first — see {@link selectNotes}. */
  readonly notes: OwnedNote[];
  /** Everything the trader holds privately. */
  readonly total: bigint;
  /** The index a new deposit should use. */
  readonly nextDepositIndex: number;
}

/**
 * Rebuild the trader's position from the pool's public state.
 *
 * Pure: same keys and same leaves always give the same answer, which is what lets this run on every
 * balance read without caching anything that could go stale or leak.
 */
export function recoverNotes(keys: PoolKeys, leaves: readonly PoolLeaf[]): RecoveredNotes {
  const byPrecommitment = new Map<string, PoolLeaf>();
  const spendByNullifierHash = new Map<string, PoolLeaf>();
  for (const leaf of leaves) {
    if (leaf.kind === 'DEPOSIT' && leaf.precommitment) {
      byPrecommitment.set(leaf.precommitment, leaf);
    } else if (leaf.kind === 'CHANGE' && leaf.spentNullifier) {
      spendByNullifierHash.set(leaf.spentNullifier, leaf);
    }
  }

  const notes: OwnedNote[] = [];
  let nextDepositIndex = 0;
  let gap = 0;

  for (let depositIndex = 0; gap < GAP_LIMIT; depositIndex += 1) {
    const first = noteAt(keys, depositIndex, 0);
    const deposit = byPrecommitment.get(precommitmentOf(first).toString());
    if (!deposit) {
      gap += 1;
      continue;
    }

    gap = 0;
    nextDepositIndex = depositIndex + 1;

    const label = BigInt(deposit.label ?? '0');
    let secret = first;
    let value = BigInt(deposit.value);
    let leaf: PoolLeaf = deposit;

    // Walk forward through every spend of this lineage. Bounded by the number of leaves: each step
    // consumes a distinct withdrawal, so it cannot loop.
    for (let step = 0; step < leaves.length + 1; step += 1) {
      const spend = spendByNullifierHash.get(nullifierHashOf(secret).toString());
      if (!spend) break;

      value -= BigInt(spend.value);
      secret = noteAt(keys, depositIndex, secret.spendIndex + 1);
      leaf = spend;
    }

    // A fully-spent lineage leaves a zero-value note. It is a real leaf and stays in the tree; it
    // is simply not worth anything, and offering it as spendable would produce a proof for a
    // withdrawal of nothing.
    if (value > 0n) {
      notes.push({
        secret,
        value,
        label,
        commitment: BigInt(leaf.commitment),
        stateIndex: leaf.index,
      });
    }
  }

  return {
    notes: notes.sort((a, b) => (b.value === a.value ? 0 : b.value > a.value ? 1 : -1)),
    total: notes.reduce((sum, n) => sum + n.value, 0n),
    nextDepositIndex,
  };
}

/**
 * Which notes to spend for a given amount, largest first.
 *
 * ## Why more than one may be needed
 *
 * The circuit spends exactly one note and mints one change note. So a withdrawal larger than any
 * single note is not one proof but several, each with its own proving time and its own relayed
 * transaction. Largest-first minimises how many, which matters: proving takes seconds, and a trader
 * funding a bet is watching a spinner for every one of them.
 *
 * Returns `null` rather than a partial plan when the balance cannot cover the amount. A partial
 * plan would move *some* money and then fail, which is the worst outcome available — collateral
 * stranded halfway between a private balance and a market account, with the UI reporting an error.
 */
export function selectNotes(notes: readonly OwnedNote[], amount: bigint): OwnedNote[] | null {
  if (amount <= 0n) return null;

  const plan: OwnedNote[] = [];
  let remaining = amount;
  for (const note of notes) {
    if (remaining <= 0n) break;
    plan.push(note);
    remaining -= note.value;
  }
  return remaining <= 0n ? plan : null;
}

/**
 * Rebuild both Merkle trees from the served state.
 *
 * The state tree holds every commitment; the association tree holds deposit labels only, so their
 * indices diverge the moment anybody withdraws. Conflating them produces a proof that generates
 * happily and is rejected on chain with a revert naming neither tree — see `pool.tree.ts` on the
 * backend, which builds the same two from the same rule.
 *
 * Order is the contract: `LeanIMT` is append-only, and the leaves arrive in chain order precisely
 * so this can insert them without sorting.
 */
export function buildTrees(leaves: readonly PoolLeaf[]): {
  state: LeanIMT;
  asp: LeanIMT;
  /** Deposit label → its index in the association tree. */
  aspIndexOf: (label: bigint) => number;
} {
  const hash = (a: bigint, b: bigint) => poseidon2([a, b]);
  const state = new LeanIMT(hash);
  const asp = new LeanIMT(hash);
  const aspIndices = new Map<string, number>();

  for (const leaf of leaves) {
    state.insert(BigInt(leaf.commitment));
    if (leaf.kind === 'DEPOSIT' && leaf.label !== null) {
      aspIndices.set(leaf.label, asp.size);
      asp.insert(BigInt(leaf.label));
    }
  }

  return { state, asp, aspIndexOf: (label) => aspIndices.get(label.toString()) ?? -1 };
}

/**
 * Confirm a note's commitment really is the leaf we think it is.
 *
 * A cheap guard against the expensive failure: proving against the wrong leaf costs thirty seconds
 * and comes back as `InvalidCommitment` from inside the pool, which points at the contract rather
 * than at the client that built the witness.
 */
export function noteMatchesLeaf(note: OwnedNote): boolean {
  return commitmentOf(note.secret, note.value, note.label) === note.commitment;
}
