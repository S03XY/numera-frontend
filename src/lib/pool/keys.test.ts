import { describe, expect, it } from 'vitest';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import type { ExecutionRoot } from '@/lib/execution/keys';
import { SNARK_FIELD } from './config';
import {
  changeNote,
  commitmentOf,
  depositNote,
  noteAt,
  nullifierHashOf,
  poolKeys,
  precommitmentOf,
} from './keys';

/**
 * The derivation every shielded balance depends on.
 *
 * Nothing here is stored anywhere. A trader's notes exist because these functions reproduce them
 * from one signature, so a change to any of them is not a refactor — it is a migration that strands
 * every existing note in a commitment nobody can open. These tests are the thing that makes that
 * visible rather than silent.
 */

const ROOT = `0x${'11'.repeat(32)}` as ExecutionRoot;
const OTHER = `0x${'22'.repeat(32)}` as ExecutionRoot;

describe('pool keys', () => {
  it('derives two independent masters from one root', () => {
    const keys = poolKeys(ROOT);

    expect(keys.nullifier).not.toBe(keys.secret);
    // Both must be valid field elements or the prover rejects the witness with an error about
    // range rather than about keys.
    expect(keys.nullifier).toBeLessThan(SNARK_FIELD);
    expect(keys.secret).toBeLessThan(SNARK_FIELD);
    expect(keys.nullifier).toBeGreaterThan(0n);
  });

  it('is deterministic, which is the whole recovery story', () => {
    // Same signature on a new laptop with an empty database reproduces every note.
    expect(poolKeys(ROOT)).toEqual(poolKeys(ROOT));
  });

  it('gives different roots entirely different notes', () => {
    expect(poolKeys(ROOT).nullifier).not.toBe(poolKeys(OTHER).nullifier);
    expect(depositNote(poolKeys(ROOT), 0).secret).not.toBe(depositNote(poolKeys(OTHER), 0).secret);
  });

  it('gives every deposit its own note', () => {
    const keys = poolKeys(ROOT);

    expect(depositNote(keys, 0).nullifier).not.toBe(depositNote(keys, 1).nullifier);
    expect(depositNote(keys, 0).secret).not.toBe(depositNote(keys, 1).secret);
  });

  /**
   * Deposit keys use Poseidon(2) and change keys Poseidon(3). Different permutations, so the
   * indices can line up however they like without two notes ever sharing a nullifier — which would
   * make one of them unspendable the moment the other was spent.
   */
  it('never collides a deposit note with a change note', () => {
    const keys = poolKeys(ROOT);

    expect(depositNote(keys, 1).nullifier).not.toBe(changeNote(keys, 1, 1).nullifier);
    expect(depositNote(keys, 0).nullifier).not.toBe(changeNote(keys, 0, 1).nullifier);
  });

  it('walks a lineage: spend 0 is the deposit, everything after is change', () => {
    const keys = poolKeys(ROOT);

    expect(noteAt(keys, 3, 0)).toEqual(depositNote(keys, 3));
    expect(noteAt(keys, 3, 1)).toEqual(changeNote(keys, 3, 1));
    expect(noteAt(keys, 3, 2)).toEqual(changeNote(keys, 3, 2));
  });

  it('records where in the lineage a note sits', () => {
    const keys = poolKeys(ROOT);

    expect(noteAt(keys, 3, 2)).toMatchObject({ depositIndex: 3, spendIndex: 2 });
  });
});

describe('the note hashes, against the circuit’s own definitions', () => {
  /*
    Spelled out longhand rather than compared to the implementation, because these three formulas
    are shared with Solidity and with a circom circuit that neither imports this file nor can be
    changed without a new trusted setup. A drift here produces commitments the pool will not open
    and a nullifier hash that marks nothing as spent — silently, and only for the money involved.
  */
  const keys = poolKeys(ROOT);
  const note = depositNote(keys, 0);

  it('precommitment is Poseidon(nullifier, secret)', () => {
    expect(precommitmentOf(note)).toBe(poseidon2([note.nullifier, note.secret]));
  });

  it('commitment is Poseidon(value, label, precommitment)', () => {
    expect(commitmentOf(note, 1_000_000n, 42n)).toBe(
      poseidon3([1_000_000n, 42n, poseidon2([note.nullifier, note.secret])]),
    );
  });

  it('nullifier hash is Poseidon(nullifier)', () => {
    expect(nullifierHashOf(note)).toBe(poseidon1([note.nullifier]));
  });

  it('a different value is a different commitment', () => {
    expect(commitmentOf(note, 1n, 42n)).not.toBe(commitmentOf(note, 2n, 42n));
  });

  it('a different label is a different commitment, so lineage cannot be forged', () => {
    expect(commitmentOf(note, 1n, 42n)).not.toBe(commitmentOf(note, 1n, 43n));
  });
});
