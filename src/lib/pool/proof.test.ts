import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { SNARK_FIELD } from './config';
import { withdrawalContext } from './proof';

/**
 * The context signal, which is the entire reason a relayer can be trusted with a withdrawal.
 *
 * Our backend submits every proof and pays for it. It could otherwise rewrite the recipient and
 * take the money. It cannot, because the recipient is folded into `context`, the pool recomputes
 * that value from the calldata it was handed, and a mismatch is a revert rather than a payout.
 *
 * Which makes this one formula the load-bearing part of the whole arrangement, and it has to agree
 * exactly with `PrivacyPool._deriveContext` in Solidity. It is spelled out longhand here rather
 * than compared against the implementation, because a shared helper would let both sides drift
 * together and still agree with each other.
 */

const ENTRYPOINT = '0xde3131ea3680c4e470c12c8F5B1262CA6a657357' as const;
const RECIPIENT = '0x9d3591e2b1054670018717bCB0194BE65099B769' as const;
const SCOPE = 4242n;

function withdrawalTo(recipient: `0x${string}`) {
  return {
    processooor: ENTRYPOINT,
    data: encodeAbiParameters(parseAbiParameters('address'), [recipient]),
  };
}

describe('withdrawal context', () => {
  it('is a valid field element', () => {
    // A keccak output is routinely larger than the field. Solidity reduces it explicitly; a client
    // that forgets to would produce a public signal the circuit silently reduces to something else.
    const context = withdrawalContext(withdrawalTo(RECIPIENT), SCOPE);

    expect(context).toBeLessThan(SNARK_FIELD);
    expect(context).toBeGreaterThan(0n);
  });

  it('is deterministic', () => {
    expect(withdrawalContext(withdrawalTo(RECIPIENT), SCOPE)).toBe(
      withdrawalContext(withdrawalTo(RECIPIENT), SCOPE),
    );
  });

  it('changes when the recipient changes — the property that stops a redirect', () => {
    const honest = withdrawalContext(withdrawalTo(RECIPIENT), SCOPE);
    const thief = withdrawalContext(withdrawalTo('0x000000000000000000000000000000000000dEaD'), SCOPE);

    expect(honest).not.toBe(thief);
  });

  it('changes when the processooor changes', () => {
    const viaEntrypoint = withdrawalContext(withdrawalTo(RECIPIENT), SCOPE);
    const viaSomethingElse = withdrawalContext(
      { ...withdrawalTo(RECIPIENT), processooor: '0x000000000000000000000000000000000000dEaD' },
      SCOPE,
    );

    expect(viaEntrypoint).not.toBe(viaSomethingElse);
  });

  it('is bound to the pool, so a proof cannot be replayed against another one', () => {
    expect(withdrawalContext(withdrawalTo(RECIPIENT), SCOPE)).not.toBe(
      withdrawalContext(withdrawalTo(RECIPIENT), SCOPE + 1n),
    );
  });

  /**
   * The encoding, pinned against Solidity's.
   *
   * `abi.encode(Withdrawal, uint256)` where `Withdrawal` is a dynamic struct — so the tuple is
   * encoded by reference, with an offset word, and getting that wrong produces a context that is
   * perfectly valid, perfectly deterministic, and equal to nothing the pool will ever compute.
   */
  it('encodes the withdrawal as a dynamic tuple followed by the scope', () => {
    const withdrawal = withdrawalTo(RECIPIENT);

    const expected =
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
            [{ processooor: withdrawal.processooor, data: withdrawal.data }, SCOPE],
          ),
        ),
      ) % SNARK_FIELD;

    expect(withdrawalContext(withdrawal, SCOPE)).toBe(expected);
  });
});
