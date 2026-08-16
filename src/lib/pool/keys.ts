import { keccak256, toBytes } from 'viem';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import type { ExecutionRoot } from '@/lib/execution/keys';
import { SNARK_FIELD } from './config';

/**
 * The keys that own a trader's shielded notes.
 *
 * ## Why every note is derived rather than stored
 *
 * A note in a privacy pool is a secret. Lose it and the money is gone — not stolen, not frozen,
 * *gone*, because the pool has no idea whose it was and no way to be told. Every wallet that stores
 * notes in the browser therefore ships an export button and a support queue full of people who
 * cleared their site data.
 *
 * Numera stores nothing. Every note is a pure function of `(execution root, deposit index, spend
 * index)`, and the execution root is itself a pure function of one wallet signature. So the
 * complete recovery procedure, on any device, with an empty database and no backup, is: sign in and
 * unlock. The chain holds the commitments; this file reproduces the secrets that open them; and
 * `notes.ts` matches the two back together.
 *
 * That is the same reasoning as `execution/keys.ts` — deriving rather than allocating — applied one
 * level deeper, and it is why this file must never gain a cache that outlives a session.
 *
 * ## The derivation
 *
 *     execution root ──keccak──> master nullifier ──┐
 *                    ──keccak──> master secret ─────┤
 *                                                   ├── Poseidon(master, i)       deposit i
 *                                                   └── Poseidon(master, i, j)    its j-th change
 *
 * Two independent masters rather than one, because the nullifier is *published* when a note is
 * spent (`Poseidon(nullifier)` goes on chain to prevent double-spends) while the secret never is.
 * Deriving both from one value would mean a revealed nullifier constrains the secret; keeping them
 * separate means it says nothing about it.
 *
 * Poseidon rather than HKDF here, and keccak above, and the difference is not stylistic: values
 * that go into the *circuit* must be field elements and are hashed with the circuit's own hash, or
 * the browser and the constraint system would disagree about what a note even is. Values that only
 * ever exist outside it use the cheaper hash.
 *
 * `poseidon2` and `poseidon3` are different permutations, so a deposit key and a change key can
 * never collide however the indices line up.
 *
 * ## What a leaked note key costs
 *
 * One note. Poseidon is one-way, so a spent note's revealed nullifier hash yields neither master,
 * and the masters are what every sibling note descends from. The blast radius of the *root* is
 * everything, which is why it never leaves the browser and is never sent to any server, ours
 * included — see `execution/keys.ts`.
 */

/** A trader's two master values. Never leaves the browser; never written to storage. */
export interface PoolKeys {
  readonly nullifier: bigint;
  readonly secret: bigint;
}

/** One spendable note, with everything needed to prove ownership of it. */
export interface NoteSecret {
  /** Which deposit this note descends from. */
  readonly depositIndex: number;
  /** How many times that lineage has been spent. 0 is the deposit itself. */
  readonly spendIndex: number;
  readonly nullifier: bigint;
  readonly secret: bigint;
}

function master(root: ExecutionRoot, label: string): bigint {
  // Reduced into the field, because a value at or above the modulus is not a valid circuit input
  // and would produce a witness the prover rejects with an error about range, not about keys.
  return BigInt(keccak256(toBytes(`${root}:${label}`))) % SNARK_FIELD;
}

/**
 * Derive both masters from the execution root.
 *
 * The labels are versioned and must never change casually: bumping either re-derives every note a
 * trader owns, and the pool would then hold commitments nobody can open. Their money would still be
 * on chain and would be unreachable forever. Treat a change as a migration with a sweep, not as a
 * constant edit.
 */
export function poolKeys(root: ExecutionRoot): PoolKeys {
  return {
    nullifier: master(root, 'numera:pool:nullifier:v1'),
    secret: master(root, 'numera:pool:secret:v1'),
  };
}

/** The note created by the trader's `index`-th deposit. */
export function depositNote(keys: PoolKeys, index: number): NoteSecret {
  return {
    depositIndex: index,
    spendIndex: 0,
    nullifier: poseidon2([keys.nullifier, BigInt(index)]),
    secret: poseidon2([keys.secret, BigInt(index)]),
  };
}

/**
 * The change note minted by the `spendIndex`-th spend of deposit `depositIndex`.
 *
 * Deterministic in both indices, which is what makes a whole lineage walkable from nothing: given
 * the masters, a client can compute note (i, 0), look for its nullifier hash on chain, and if it
 * finds one, compute (i, 1) and continue. The chain says how far the chain got; nothing needs to be
 * remembered between sessions.
 */
export function changeNote(keys: PoolKeys, depositIndex: number, spendIndex: number): NoteSecret {
  return {
    depositIndex,
    spendIndex,
    nullifier: poseidon3([keys.nullifier, BigInt(depositIndex), BigInt(spendIndex)]),
    secret: poseidon3([keys.secret, BigInt(depositIndex), BigInt(spendIndex)]),
  };
}

/** The next note in a lineage: deposit at spend 0, change after that. */
export function noteAt(keys: PoolKeys, depositIndex: number, spendIndex: number): NoteSecret {
  return spendIndex === 0
    ? depositNote(keys, depositIndex)
    : changeNote(keys, depositIndex, spendIndex);
}

/** `Poseidon(nullifier, secret)` — what a deposit publishes, and how a client recognises its own. */
export function precommitmentOf(note: NoteSecret): bigint {
  return poseidon2([note.nullifier, note.secret]);
}

/** `Poseidon(value, label, precommitment)` — the leaf itself. */
export function commitmentOf(note: NoteSecret, value: bigint, label: bigint): bigint {
  return poseidon3([value, label, precommitmentOf(note)]);
}

/** `Poseidon(nullifier)` — published on spend, and what marks a note as used. */
export function nullifierHashOf(note: NoteSecret): bigint {
  return poseidon1([note.nullifier]);
}
