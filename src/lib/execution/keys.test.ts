// @vitest-environment node
//
// Node rather than jsdom: this exercises real key derivation through @noble, which rejects
// Uint8Arrays minted in another realm. Same reason as identity.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  deriveExecutionRoot,
  ExecutionKeyError,
  marketAccount,
  marketAccountAddress,
  marketAccountKey,
  marketAccountMessage,
  type ExecutionRoot,
} from './keys';
import type { WalletSigner } from '@/lib/wallet/types';

const WALLET = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const OTHER = privateKeyToAccount(
  '0xa961d09ddb2e2ca0c49e451973a5f0bbd5c93936d71e99f47f5982f3164510c7',
);

const MARKET_A = '767526dc-c2c6-447e-b4dc-b27ddc87104f';
const MARKET_B = '11111111-1111-4111-8111-111111111111';

function signerFor(account: typeof WALLET): WalletSigner {
  return {
    address: account.address,
    kind: 'passkey',
    signMessage: (message: string) => account.signMessage({ message }),
  } as WalletSigner;
}

const root = (signer = signerFor(WALLET)) =>
  deriveExecutionRoot({ signer, appId: 'numera', chainId: 10143 });

describe('the message that derives everything', () => {
  it('is canonical and versioned (positive)', () => {
    expect(marketAccountMessage({ appId: 'numera', chainId: 10143 })).toBe(
      'Numera: derive market accounts\nApp: numera\nChain: 10143\nVersion: 1',
    );
  });

  it('separates chains, so one wallet cannot collide across networks (negative)', () => {
    expect(marketAccountMessage({ appId: 'numera', chainId: 1 })).not.toBe(
      marketAccountMessage({ appId: 'numera', chainId: 10143 }),
    );
  });
});

describe('the root secret', () => {
  it('is reproducible from the same wallet (positive)', async () => {
    // The whole recovery story: clear the browser, sign again, get every account back. If this
    // is ever non-deterministic, positions become unreachable with no error anywhere.
    expect(await root()).toBe(await root());
  });

  it('differs per wallet (negative)', async () => {
    expect(await root(signerFor(WALLET))).not.toBe(await root(signerFor(OTHER)));
  });

  it('is not the signature itself (safety)', async () => {
    // Hashed rather than used raw: a signature is 65 structured bytes, HKDF wants uniform input,
    // and a root that *is* the signature would be recoverable from anything that ever saw it.
    const signature = await WALLET.signMessage({
      message: marketAccountMessage({ appId: 'numera', chainId: 10143 }),
    });
    expect(await root()).not.toBe(signature);
    expect((await root()).length).toBe(66);
  });

  it('refuses a malformed signature rather than deriving from it (negative)', async () => {
    // A wallet returning a truncated signature would still hash to *something*, producing accounts
    // that look fine and that a correct wallet can never reproduce.
    const broken = { ...signerFor(WALLET), signMessage: vi.fn(async () => '0xdeadbeef') };
    await expect(
      deriveExecutionRoot({ signer: broken as never, appId: 'numera', chainId: 10143 }),
    ).rejects.toThrow(ExecutionKeyError);
  });
});

describe('per-market keys', () => {
  it('are stable for a market (positive)', async () => {
    const r = await root();
    expect(marketAccountKey(r, MARKET_A)).toBe(marketAccountKey(r, MARKET_A));
  });

  it('are independent across markets (safety)', async () => {
    // The blast radius of a leaked market key is that market's float and nothing else. If two
    // markets shared a key, one compromise would take both.
    const r = await root();
    expect(marketAccountKey(r, MARKET_A)).not.toBe(marketAccountKey(r, MARKET_B));
  });

  it('are independent across users (safety)', async () => {
    const [a, b] = [await root(signerFor(WALLET)), await root(signerFor(OTHER))];
    expect(marketAccountKey(a, MARKET_A)).not.toBe(marketAccountKey(b, MARKET_A));
  });

  it('always lands inside the secp256k1 range (safety)', async () => {
    // HKDF output is uniform over 2^256, so a value at or above the curve order is vanishingly
    // unlikely — but a zero key would be a silent catastrophe rather than an error, so the
    // derivation retries with a counter instead of trusting the odds.
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = await root();
    for (let i = 0; i < 40; i += 1) {
      const value = BigInt(marketAccountKey(r, `market-${i}`));
      expect(value).toBeGreaterThan(0n);
      expect(value).toBeLessThan(n);
    }
  });

  it('rejects an empty market reference (negative)', async () => {
    const r = await root();
    expect(() => marketAccountKey(r, '')).toThrow(ExecutionKeyError);
  });

  it('does not reveal the root (safety)', async () => {
    const r = await root();
    expect(marketAccountKey(r, MARKET_A)).not.toBe(r);
  });
});

describe('the account itself', () => {
  it('is the trader on chain, and is not the wallet (REGRESSION)', async () => {
    // The entire privacy claim in one assertion. If a market account ever equals the user's own
    // address, every position it holds is publicly theirs.
    const r = await root();
    const address = marketAccountAddress(r, MARKET_A);
    expect(address.toLowerCase()).not.toBe(WALLET.address.toLowerCase());
  });

  it('gives a different address per market (safety)', async () => {
    // One address across markets would make a user's bets linkable to each other, which is most
    // of what the per-market split is for.
    const r = await root();
    expect(marketAccountAddress(r, MARKET_A)).not.toBe(marketAccountAddress(r, MARKET_B));
  });

  it('matches the key it claims to be derived from (positive)', async () => {
    const r = await root();
    expect(marketAccount(r, MARKET_A).address).toBe(
      privateKeyToAccount(marketAccountKey(r, MARKET_A)).address,
    );
  });

  it('reproduces a known address from a known root (REGRESSION)', async () => {
    // A golden vector. Any change to the message, the HKDF salt, or the info string silently
    // re-derives every user's accounts and makes their positions unreachable — this fails first.
    const fixed = ('0x' + '11'.repeat(32)) as ExecutionRoot;
    expect(marketAccountAddress(fixed, MARKET_A)).toMatchInlineSnapshot(
      `"0xDd1621E65ed4c6782DFAFB79d82cB8AF1410D7e1"`,
    );
  });
});
