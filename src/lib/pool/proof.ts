import { encodeAbiParameters, keccak256 } from 'viem';
import type { LeanIMT } from '@zk-kit/lean-imt';
import { MAX_TREE_DEPTH, SNARK_FIELD, ZK_ARTIFACTS } from './config';
import { noteAt, type PoolKeys } from './keys';
import type { OwnedNote } from './notes';

/**
 * Generating a withdrawal proof, in the browser, on purpose.
 *
 * ## Why this cannot move to a server
 *
 * The witness contains the note's nullifier and secret. Anything that sees those can spend the
 * note, and anything that merely *logs* them alongside a request has recorded which trader owns
 * which shielded balance. A proving service would therefore be handed, in one payload, both halves
 * of the link the pool exists to break — and would be the single most valuable thing in the system
 * to compromise.
 *
 * So the cost is paid where it belongs: a 17MB proving key download, cached by the browser after
 * the first bet, and a few seconds of proving on the trader's own machine. That is a real cost and
 * it buys the only meaningful privacy guarantee in the product.
 *
 * ## What is public and what is not
 *
 * Eight public signals leave this file: the new commitment, the spent nullifier hash, the amount,
 * the two tree roots and their depths, and the context. The context is `keccak(withdrawal, scope)`
 * reduced into the field, and it is what stops a relayer redirecting a payout — the recipient is
 * inside it, the pool recomputes it, and a tampered recipient produces a mismatch rather than a
 * theft. Everything else — which note, whose note, where it sits — stays in this function.
 */

export class ProofError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProofError';
  }
}

/** A Groth16 proof in the shape the Solidity verifier takes. */
export interface SolidityProof {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
}

export interface WithdrawalIntent {
  /** Always the entrypoint: the pool pays whoever processes, and only it forwards onward. */
  processooor: `0x${string}`;
  /** `abi.encode(address recipient)`. */
  data: `0x${string}`;
}

/**
 * The value the pool re-derives and compares against the proof.
 *
 * `keccak256(abi.encode(withdrawal, scope)) % SNARK_SCALAR_FIELD`, and every part of that matters.
 * The modulus because a keccak output is routinely larger than the field and would be silently
 * reduced by the circuit but not by Solidity, so the two would disagree. The `scope` because a
 * proof for one pool must not be replayable against another.
 */
export function withdrawalContext(withdrawal: WithdrawalIntent, scope: bigint): bigint {
  return (
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'processooor', type: 'address' },
                { name: 'data', type: 'bytes' },
              ],
            },
            { type: 'uint256' },
          ],
          [withdrawal, scope],
        ),
      ),
    ) % SNARK_FIELD
  );
}

/** Pad a sibling path to the circuit's fixed depth. A short array is a malformed witness. */
function pad(siblings: bigint[]): bigint[] {
  if (siblings.length > MAX_TREE_DEPTH) {
    throw new ProofError('The shielded pool has grown beyond the depth this circuit supports.');
  }
  return [...siblings, ...Array<bigint>(MAX_TREE_DEPTH - siblings.length).fill(0n)];
}

export interface ProveParams {
  keys: PoolKeys;
  note: OwnedNote;
  /** How much of the note to withdraw. The remainder becomes a fresh note. */
  amount: bigint;
  state: LeanIMT;
  asp: LeanIMT;
  aspIndex: number;
  scope: bigint;
  withdrawal: WithdrawalIntent;
}

/**
 * Prove the right to withdraw `amount` from `note`.
 *
 * The change note's keys are the *next* in the same lineage, which is what makes the whole balance
 * recoverable later from nothing but the master keys — see `notes.ts`. Getting this wrong does not
 * fail here: the withdrawal succeeds, the remainder lands in a commitment nobody can open, and the
 * money is gone with no error anywhere.
 */
export async function proveWithdrawal(params: ProveParams): Promise<SolidityProof> {
  const { keys, note, amount, state, asp, aspIndex, scope, withdrawal } = params;

  if (amount <= 0n || amount > note.value) {
    throw new ProofError('That is not an amount this note can cover.');
  }
  if (aspIndex < 0) {
    throw new ProofError(
      'This deposit is not in the association set yet. It usually clears within a minute.',
    );
  }

  const statePath = state.generateProof(note.stateIndex);
  const aspPath = asp.generateProof(aspIndex);
  const change = noteAt(keys, note.secret.depositIndex, note.secret.spendIndex + 1);

  const { groth16 } = await loadSnark();
  let proof: import('snarkjs').Groth16Proof;
  let publicSignals: string[];
  try {
    ({ proof, publicSignals } = await groth16.fullProve(
      {
        withdrawnValue: amount,
        stateRoot: state.root,
        stateTreeDepth: statePath.siblings.length,
        ASPRoot: asp.root,
        ASPTreeDepth: aspPath.siblings.length,
        context: withdrawalContext(withdrawal, scope),
        label: note.label,
        existingValue: note.value,
        existingNullifier: note.secret.nullifier,
        existingSecret: note.secret.secret,
        newNullifier: change.nullifier,
        newSecret: change.secret,
        stateSiblings: pad(statePath.siblings),
        stateIndex: statePath.index,
        ASPSiblings: pad(aspPath.siblings),
        ASPIndex: aspPath.index,
      },
      ZK_ARTIFACTS.wasm,
      ZK_ARTIFACTS.zkey,
    ));
  } catch (err) {
    throw new ProofError(
      'Your browser could not finish the privacy proof. Nothing was sent and your balance is ' +
        'unchanged. This is usually a reload away from working.',
      { cause: err },
    );
  }

  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    /*
      G2 coordinates are swapped for the Solidity verifier, and this is the classic way to lose an
      afternoon: a proof built with them in snarkjs order verifies perfectly off chain and fails on
      chain with nothing but a false from the pairing check.
    */
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
  };
}

type Snark = typeof import('snarkjs');

let snark: Promise<Snark> | null = null;

/**
 * Load snarkjs on first use, and only in the browser.
 *
 * Dynamic because it is large and because most sessions never prove anything — somebody reading
 * the markets list should not pay for a prover. Memoised because the second bet should not either.
 */
function loadSnark(): Promise<Snark> {
  if (typeof window === 'undefined') {
    return Promise.reject(new ProofError('Proofs are generated in the browser, never on a server.'));
  }
  snark ??= import('snarkjs');
  return snark;
}
