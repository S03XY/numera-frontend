// @vitest-environment node
//
// Node rather than jsdom: real signing runs through @noble, which rejects Uint8Arrays minted in
// another realm. Same reason as keys.test.ts.
import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MAX_RELAY_GAS,
  RELAY_GAS,
  RelayError,
  encodeRelayableCall,
  signForwardRequest,
  signPermit,
  toRelayPayload,
} from './relay';

const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const FORWARDER = '0x1111111111111111111111111111111111111111' as const;
const ENGINE = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const CHAIN_ID = 10143;

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

const buyData = () => encodeRelayableCall('buy', [1n, 0n, 10_000_000n, 20_000_000n]);

async function sign(overrides: Partial<Parameters<typeof signForwardRequest>[0]> = {}) {
  return signForwardRequest({
    account: ACCOUNT,
    forwarder: FORWARDER,
    chainId: CHAIN_ID,
    to: ENGINE,
    data: buyData(),
    nonce: 0n,
    ...overrides,
  });
}

describe('the signed request', () => {
  it('recovers to the market account and nobody else (REGRESSION)', async () => {
    // The whole authorisation model. If a request recovered to any other address, the forwarder
    // would credit the position to that address — or reject the trade outright.
    const request = await sign();
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Numera Forwarder',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: FORWARDER,
      },
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: {
        from: ACCOUNT.address,
        to: ENGINE,
        value: 0n,
        gas: RELAY_GAS,
        nonce: 0n,
        deadline: request.deadline,
        data: request.data,
      },
      signature: request.signature,
    });

    expect(recovered).toBe(ACCOUNT.address);
  });

  it('uses the typehash the contract uses (REGRESSION)', () => {
    // The forwarder recomputes this hash from its own constant. Any drift — a renamed field, a
    // reordered one, `uint256 deadline` instead of `uint48` — makes every signature unverifiable,
    // with no error that says why.
    expect(
      keccak256(
        toHex(
          'ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)',
        ),
      ),
    ).toMatchInlineSnapshot(
      `"0x7f96328b83274ebc7c1cf4f7a3abda602b51a78b7fa1d86a2ce353d75e587cac"`,
    );
  });

  it('never carries native value (safety)', async () => {
    // The engine is not payable and the forwarder refuses value outright. Signing a non-zero value
    // would produce a request that can only ever revert.
    expect((await sign()).value).toBe(0n);
  });

  it('omits the nonce from the submitted struct (positive)', async () => {
    // Signed over, but not sent: the forwarder reads the account's live nonce itself. That is what
    // makes a replay impossible rather than merely detectable.
    expect('nonce' in (await sign())).toBe(false);
  });

  it('binds the chain, so a signature cannot be replayed on another network (safety)', async () => {
    const a = await sign({ chainId: 10143 });
    const b = await sign({ chainId: 1 });
    expect(a.signature).not.toBe(b.signature);
  });

  it('binds the forwarder, so one deployment cannot replay another (safety)', async () => {
    const a = await sign({ forwarder: FORWARDER });
    const b = await sign({ forwarder: '0x9999999999999999999999999999999999999999' });
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces a different signature for every nonce (positive)', async () => {
    const a = await sign({ nonce: 0n });
    const b = await sign({ nonce: 1n });
    expect(a.signature).not.toBe(b.signature);
  });

  it('refuses to ask for more gas than the chain will forward (negative)', async () => {
    // Better to fail here than to have the forwarder reject it after a round trip the user waited
    // through.
    await expect(sign({ gas: MAX_RELAY_GAS + 1n })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sign({ gas: MAX_RELAY_GAS + 1n })).rejects.toBeInstanceOf(RelayError);
  });

  it('expires (safety)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = await sign();
    expect(request.deadline).toBeGreaterThan(now);
    expect(request.deadline).toBeLessThanOrEqual(now + 601);
  });
});

describe('the permit', () => {
  it('recovers to the market account (REGRESSION)', async () => {
    const permit = await signPermit({
      account: ACCOUNT,
      token: TOKEN,
      tokenName: 'Numera Test USD',
      spender: ENGINE,
      chainId: CHAIN_ID,
      nonce: 0n,
    });

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Numera Test USD',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: TOKEN,
      },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: ACCOUNT.address,
        spender: ENGINE,
        value: permit.value,
        nonce: 0n,
        deadline: permit.deadline,
      },
      signature: `0x${permit.r.slice(2)}${permit.s.slice(2)}${permit.v.toString(16)}`,
    });

    expect(recovered).toBe(ACCOUNT.address);
  });

  it('splits into a v in the legal range (REGRESSION)', async () => {
    // `permit` takes v/r/s rather than a packed signature. A v of 0 or 1 instead of 27 or 28 is the
    // classic way this silently recovers to a garbage address that owns nothing.
    const permit = await signPermit({
      account: ACCOUNT,
      token: TOKEN,
      tokenName: 'Numera Test USD',
      spender: ENGINE,
      chainId: CHAIN_ID,
      nonce: 0n,
    });
    expect([27, 28]).toContain(permit.v);
    expect(permit.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(permit.s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('the wire format', () => {
  it('carries every bigint as a string (REGRESSION)', async () => {
    // `JSON.stringify` throws on a bigint. Serialising by hand somewhere else is how a field
    // quietly becomes `null` and the relayer verifies a signature over different data.
    const request = await sign();
    const permit = await signPermit({
      account: ACCOUNT,
      token: TOKEN,
      tokenName: 'Numera Test USD',
      spender: ENGINE,
      chainId: CHAIN_ID,
      nonce: 0n,
    });

    const payload = toRelayPayload(request, permit);
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload.request.value).toBe('0');
    expect(payload.request.gas).toBe(RELAY_GAS.toString());
    expect(payload.permit?.value).toBe(permit.value.toString());
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('omits the permit when there is none (positive)', async () => {
    expect(toRelayPayload(await sign()).permit).toBeUndefined();
  });
});

describe('call encoding', () => {
  it('produces the selectors the forwarder allows (REGRESSION)', () => {
    // These four are hardcoded in `NumeraForwarder.isRelayable`. If an encoding here drifted, every
    // trade would be rejected on chain as a forbidden selector.
    // Values from `cast sig` against the deployed signatures, not from this encoder.
    expect(encodeRelayableCall('buy', [1n, 0n, 1n, 1n]).slice(0, 10)).toBe('0x1281311d');
    expect(encodeRelayableCall('buyComplement', [1n, 0n, 1n, 1n]).slice(0, 10)).toBe('0x9be7b6a1');
    expect(encodeRelayableCall('sell', [1n, 0n, 1n, 1n]).slice(0, 10)).toBe('0x3620875e');
    expect(encodeRelayableCall('redeem', [1n]).slice(0, 10)).toBe('0xdb006a75');
  });
});
