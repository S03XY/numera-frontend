import { describe, expect, it } from 'vitest';
import type { ExecutionRoot } from '@/lib/execution/keys';
import {
  commitmentOf,
  depositNote,
  noteAt,
  nullifierHashOf,
  poolKeys,
  precommitmentOf,
} from './keys';
import {
  buildTrees,
  GAP_LIMIT,
  noteMatchesLeaf,
  recoverNotes,
  selectNotes,
  type PoolLeaf,
} from './notes';

/**
 * Finding a trader's money in a pool that has no idea who they are.
 *
 * This is the file that decides whether a balance appears at all. Every failure mode below has the
 * same symptom for the user — their money is simply not there — and none of them raises an error
 * anywhere, which is why they are pinned individually.
 */

const ROOT = `0x${'aa'.repeat(32)}` as ExecutionRoot;
const KEYS = poolKeys(ROOT);
const STRANGER = poolKeys(`0x${'bb'.repeat(32)}` as ExecutionRoot);

let position = 0;

function reset() {
  position = 0;
}

/** A deposit leaf owned by `keys`, at deposit index `i`. */
function deposit(keys: typeof KEYS, i: number, value: bigint, label: bigint): PoolLeaf {
  const note = depositNote(keys, i);
  return {
    index: position++,
    kind: 'DEPOSIT',
    commitment: commitmentOf(note, value, label).toString(),
    label: label.toString(),
    value: value.toString(),
    precommitment: precommitmentOf(note).toString(),
    spentNullifier: null,
  };
}

/** A withdrawal spending note `(i, spend - 1)` and minting the remainder as `(i, spend)`. */
function spend(
  keys: typeof KEYS,
  i: number,
  spendIndex: number,
  amount: bigint,
  remainder: bigint,
  label: bigint,
): PoolLeaf {
  const spent = noteAt(keys, i, spendIndex - 1);
  const change = noteAt(keys, i, spendIndex);
  return {
    index: position++,
    kind: 'CHANGE',
    commitment: commitmentOf(change, remainder, label).toString(),
    label: null,
    value: amount.toString(),
    precommitment: null,
    spentNullifier: nullifierHashOf(spent).toString(),
  };
}

/** Somebody else's deposit. The pool is full of these and none of them is ours. */
function foreign(value: bigint): PoolLeaf {
  return {
    index: position++,
    kind: 'DEPOSIT',
    commitment: (999_000n + BigInt(position)).toString(),
    label: (777n + BigInt(position)).toString(),
    value: value.toString(),
    precommitment: (888_000n + BigInt(position)).toString(),
    spentNullifier: null,
  };
}

describe('recovering notes from public state', () => {
  it('finds an untouched deposit (positive)', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n)];

    const { notes, total, nextDepositIndex } = recoverNotes(KEYS, leaves);

    expect(total).toBe(100n);
    expect(notes).toHaveLength(1);
    expect(notes[0].value).toBe(100n);
    expect(notes[0].label).toBe(7n);
    expect(notes[0].stateIndex).toBe(0);
    expect(nextDepositIndex).toBe(1);
  });

  it('follows a lineage through a partial spend to the change note', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), spend(KEYS, 0, 1, 40n, 60n, 7n)];

    const { notes, total } = recoverNotes(KEYS, leaves);

    expect(total).toBe(60n);
    expect(notes[0].secret.spendIndex).toBe(1);
    // The change note is the withdrawal's own leaf, and its position in the tree is that leaf's.
    expect(notes[0].stateIndex).toBe(1);
    expect(notes[0].label).toBe(7n);
  });

  it('follows several spends of the same deposit', () => {
    reset();
    const leaves = [
      deposit(KEYS, 0, 100n, 7n),
      spend(KEYS, 0, 1, 40n, 60n, 7n),
      spend(KEYS, 0, 2, 25n, 35n, 7n),
    ];

    const { notes, total } = recoverNotes(KEYS, leaves);

    expect(total).toBe(35n);
    expect(notes[0].secret.spendIndex).toBe(2);
  });

  it('reports nothing for a lineage spent to zero (negative)', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), spend(KEYS, 0, 1, 100n, 0n, 7n)];

    const { notes, total } = recoverNotes(KEYS, leaves);

    // The zero note is a real leaf and stays in the tree. Offering it as spendable would produce a
    // proof for a withdrawal of nothing.
    expect(notes).toHaveLength(0);
    expect(total).toBe(0n);
  });

  it('sums several deposits', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), deposit(KEYS, 1, 250n, 9n)];

    const { notes, total, nextDepositIndex } = recoverNotes(KEYS, leaves);

    expect(total).toBe(350n);
    expect(notes).toHaveLength(2);
    expect(nextDepositIndex).toBe(2);
  });

  it('sorts largest first, so a withdrawal needs as few proofs as possible', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 10n, 7n), deposit(KEYS, 1, 500n, 9n), deposit(KEYS, 2, 80n, 3n)];

    expect(recoverNotes(KEYS, leaves).notes.map((n) => n.value)).toEqual([500n, 80n, 10n]);
  });

  /** The property that makes the pool a pool. */
  it('claims nothing belonging to anybody else (negative)', () => {
    reset();
    const leaves = [foreign(1_000n), deposit(KEYS, 0, 100n, 7n), foreign(5_000n)];

    const mine = recoverNotes(KEYS, leaves);
    const theirs = recoverNotes(STRANGER, leaves);

    expect(mine.total).toBe(100n);
    expect(theirs.total).toBe(0n);
  });

  it('finds our deposit among a crowd, at its real tree index', () => {
    reset();
    const leaves = [foreign(1n), foreign(2n), deposit(KEYS, 0, 100n, 7n), foreign(3n)];

    expect(recoverNotes(KEYS, leaves).notes[0].stateIndex).toBe(2);
  });

  it('sees past a burnt index, because a reverted deposit leaves a gap', () => {
    reset();
    // Index 1 was never used — the transaction reverted. Index 2 must still be found.
    const leaves = [deposit(KEYS, 0, 100n, 7n), deposit(KEYS, 2, 60n, 9n)];

    const { total, nextDepositIndex } = recoverNotes(KEYS, leaves);

    expect(total).toBe(160n);
    expect(nextDepositIndex).toBe(3);
  });

  it('stops looking after the gap limit, rather than scanning forever', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), deposit(KEYS, GAP_LIMIT + 5, 60n, 9n)];

    // Beyond the gap the scan gives up. That is a deliberate bound: the alternative is an
    // unbounded loop on every balance read.
    expect(recoverNotes(KEYS, leaves).total).toBe(100n);
  });

  it('finds nothing in an empty pool', () => {
    expect(recoverNotes(KEYS, [])).toEqual({ notes: [], total: 0n, nextDepositIndex: 0 });
  });
});

describe('choosing which notes to spend', () => {
  const note = (value: bigint) => ({ value }) as never;

  it('takes one note when one is enough', () => {
    expect(selectNotes([note(100n), note(50n)], 40n)).toHaveLength(1);
  });

  it('combines notes when none alone can cover it', () => {
    // The circuit spends exactly one note, so this is genuinely two proofs and two transactions.
    expect(selectNotes([note(100n), note(50n)], 130n)).toHaveLength(2);
  });

  it('refuses rather than planning a partial move (negative)', () => {
    /*
      Returning a partial plan would move some of the money and then fail — collateral stranded
      halfway between a private balance and a market account, with the UI reporting an error. That
      is strictly worse than not starting.
    */
    expect(selectNotes([note(100n)], 150n)).toBeNull();
  });

  it('refuses zero and negative amounts', () => {
    expect(selectNotes([note(100n)], 0n)).toBeNull();
    expect(selectNotes([note(100n)], -5n)).toBeNull();
  });

  it('refuses when there is nothing to spend', () => {
    expect(selectNotes([], 1n)).toBeNull();
  });
});

describe('the two trees', () => {
  it('puts every leaf in the state tree and only deposits in the association set', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), spend(KEYS, 0, 1, 40n, 60n, 7n), foreign(5n)];

    const { state, asp } = buildTrees(leaves);

    expect(state.size).toBe(3);
    expect(asp.size).toBe(2);
  });

  it('maps a label to its association index, which is not its state index', () => {
    reset();
    const leaves = [deposit(KEYS, 0, 100n, 7n), spend(KEYS, 0, 1, 40n, 60n, 7n), deposit(KEYS, 1, 5n, 9n)];

    const { aspIndexOf } = buildTrees(leaves);

    // The second deposit is at state index 2 and association index 1. Passing one where the other
    // belongs generates a proof happily and is rejected on chain, naming neither tree.
    expect(aspIndexOf(9n)).toBe(1);
    expect(aspIndexOf(7n)).toBe(0);
  });

  it('reports an unknown label rather than guessing an index', () => {
    reset();
    expect(buildTrees([deposit(KEYS, 0, 100n, 7n)]).aspIndexOf(123n)).toBe(-1);
  });
});

describe('verifying a note against its leaf', () => {
  it('accepts a note that reproduces its commitment', () => {
    reset();
    const [note] = recoverNotes(KEYS, [deposit(KEYS, 0, 100n, 7n)]).notes;

    expect(noteMatchesLeaf(note)).toBe(true);
  });

  it('rejects one that does not (negative)', () => {
    reset();
    const [note] = recoverNotes(KEYS, [deposit(KEYS, 0, 100n, 7n)]).notes;

    // Cheap guard against the expensive failure: proving against the wrong leaf costs thirty
    // seconds and comes back as `InvalidCommitment` from inside the pool.
    expect(noteMatchesLeaf({ ...note, value: 99n })).toBe(false);
    expect(noteMatchesLeaf({ ...note, label: 8n })).toBe(false);
  });
});
