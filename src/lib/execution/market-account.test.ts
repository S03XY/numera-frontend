// @vitest-environment node
//
// Node rather than jsdom: real key derivation runs through @noble, which rejects Uint8Arrays
// minted in another realm. Same reason as keys.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addressFor,
  ExecutionError,
  fundMarket,
  returnToPool,
  sendAs,
  type ExecutionContext,
} from './market-account';
import type { ExecutionRoot } from './keys';
import type { ShieldedPool } from './pool';

const ROOT = ('0x' + '11'.repeat(32)) as ExecutionRoot;
const MARKET = '767526dc-c2c6-447e-b4dc-b27ddc87104f';
const TOKEN = '0x2222222222222222222222222222222222222222';
const ENGINE = '0x1111111111111111111111111111111111111111';
/** The trader's own wallet. Nothing here may ever route money through it. */
const USER_WALLET = '0x9d3591e2b1054670018717bCB0194BE65099B769';

function makePool(): ShieldedPool & {
  deposit: ReturnType<typeof vi.fn>;
  withdraw: ReturnType<typeof vi.fn>;
} {
  return {
    balance: vi.fn(async () => ({
      total: 500_000_000n,
      spendable: 500_000_000n,
      pendingChange: 0n,
      syncing: false,
    })),
    held: vi.fn(async () => ({ total: 0n, operations: [] })),
    deposit: vi.fn(async (_p: { token: string; amount: bigint; wallet: unknown }) => undefined),
    withdraw: vi.fn(
      async (_p: { token: string; amount: bigint; recipient: string }) => undefined,
    ),
  } as never;
}

let pool: ReturnType<typeof makePool>;
let receipt: { status: string };
let rpc: { waitForTransactionReceipt: ReturnType<typeof vi.fn> };
/** Stands in for the derived signer, so these paths need no funded account and no chain. */
let send: ReturnType<typeof vi.fn>;

function ctx(): ExecutionContext {
  return {
    pool,
    root: ROOT,
    gas: { ensure: vi.fn(async () => undefined) },
    marketRef: MARKET,
    token: TOKEN,
    rpc: rpc as never,
    walletFor: (root, marketRef) =>
      ({
        // The real derivation, so an assertion about *which* account signed still means something.
        account: { address: addressFor({ root, marketRef }) },
        sendTransaction: send,
      }) as never,
  };
}

beforeEach(() => {
  pool = makePool();
  receipt = { status: 'success' };
  rpc = { waitForTransactionReceipt: vi.fn(async () => receipt) };
  send = vi.fn(async () => '0xhash');
});

describe('the account that holds the position', () => {
  it('is derived, not allocated (positive)', () => {
    // No registry, no slot, nothing to lose. The address is a pure function of the root and the
    // market, which is what removes "restore your positions" from the product entirely.
    expect(addressFor({ root: ROOT, marketRef: MARKET })).toBe(
      addressFor({ root: ROOT, marketRef: MARKET }),
    );
  });

  it('is never the trader’s own address (REGRESSION)', () => {
    // The entire privacy claim. If these ever coincide, every position is publicly the user's.
    expect(addressFor({ root: ROOT, marketRef: MARKET }).toLowerCase()).not.toBe(
      USER_WALLET.toLowerCase(),
    );
  });
});

describe('funding a market from the pool', () => {
  it('withdraws to the derived account and nowhere else (REGRESSION)', async () => {
    // A withdrawal to the user's own address would put the collateral — and then the position —
    // under a public identity. The recipient must always be the derived account.
    const { account } = await fundMarket(ctx(), { amount: 10_000_000n });

    expect(account).toBe(addressFor({ root: ROOT, marketRef: MARKET }));
    expect(pool.withdraw).toHaveBeenCalledTimes(1);
    expect(pool.withdraw.mock.calls[0][0]).toEqual({
      token: TOKEN,
      amount: 10_000_000n,
      recipient: account,
    });
  });

  it('crosses the pool exactly once (positive)', async () => {
    // One ordinary transfer, not a session with a funding leg, calls, and a return. The whole
    // point is that there is no half-finished state to strand anything in.
    await fundMarket(ctx(), { amount: 5_000_000n });
    expect(pool.withdraw).toHaveBeenCalledTimes(1);
    expect(pool.deposit).not.toHaveBeenCalled();
  });

  it('refuses zero and negative amounts before touching the pool (negative)', async () => {
    for (const amount of [0n, -1n]) {
      await expect(fundMarket(ctx(), { amount })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(pool.withdraw).not.toHaveBeenCalled();
  });

  it('refuses an amount larger than a note can hold (negative)', async () => {
    await expect(fundMarket(ctx(), { amount: 1n << 121n })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(pool.withdraw).not.toHaveBeenCalled();
  });

  it('says the balance is untouched when the pool refuses (negative)', async () => {
    // True of this design in a way it was not of the last one: a failed withdrawal releases its
    // notes, so "untouched" is a promise we can actually keep.
    pool.withdraw.mockRejectedValue(new Error('relayer down'));
    const err = (await fundMarket(ctx(), { amount: 1_000_000n }).catch((e) => e)) as ExecutionError;

    expect(err).toBeInstanceOf(ExecutionError);
    expect(err.code).toBe('pool');
    expect(err.message).toMatch(/private balance is untouched/i);
  });
});

describe('returning collateral to the pool', () => {
  it('deposits as the market account, into the user’s balance (REGRESSION)', async () => {
    // Depositor and recipient are independent: the account signs, the user's private balance is
    // credited. That split is the mechanism the whole return leg rests on.
    await returnToPool(ctx(), { amount: 4_000_000n });

    expect(pool.deposit).toHaveBeenCalledTimes(1);
    const sent = pool.deposit.mock.calls[0][0] as { amount: bigint; wallet: { account: { address: string } } };
    expect(sent.amount).toBe(4_000_000n);
    expect(sent.wallet.account.address).toBe(addressFor({ root: ROOT, marketRef: MARKET }));
  });

  it('never routes the return through the trader’s wallet (REGRESSION)', async () => {
    // A deposit signed by the user's own wallet would publish the link between them and the
    // account that has been holding their position.
    await returnToPool(ctx(), { amount: 1_000_000n });
    const sent = pool.deposit.mock.calls[0][0] as { wallet: { account: { address: string } } };
    expect(sent.wallet.account.address.toLowerCase()).not.toBe(USER_WALLET.toLowerCase());
  });

  it('refuses an empty account (negative)', async () => {
    await expect(returnToPool(ctx(), { amount: 0n })).rejects.toMatchObject({ code: 'invalid' });
    expect(pool.deposit).not.toHaveBeenCalled();
  });

  it('says the collateral is still in the account when the pool refuses (negative)', async () => {
    pool.deposit.mockRejectedValue(new Error('engine down'));
    const err = (await returnToPool(ctx(), { amount: 1n }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('pool');
    expect(err.message).toMatch(/still in this market’s account/i);
    expect(err.message).toMatch(/nothing was lost/i);
  });
});

describe('sending a transaction as the market account', () => {
  it('treats a reverted receipt as a failure (REGRESSION)', async () => {
    // A transaction that lands and reverts still returns a hash. Reading only the hash is how a
    // rejected bet gets reported as placed, leaving the trader with no position and no error.
    receipt = { status: 'reverted' };
    const err = (await sendAs(ctx(), {
      to: ENGINE,
      data: '0x1234',
      label: 'bet',
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('rejected');
    expect(err.message).toMatch(/rejected by the market/i);
  });

  it('names an unfunded account rather than surfacing RPC hex (negative)', async () => {
    // Monad reserves gasLimit × maxFeePerGas up front, so an account with some gas but not enough
    // fails at broadcast. "Signer had insufficient balance" about an address the trader has never
    // seen is meaningless to them, and it is not their fault.
    send.mockRejectedValue(new Error('Signer had insufficient balance'));

    const err = (await sendAs(ctx(), {
      to: ENGINE,
      data: '0x1234',
      label: 'bet',
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('no-gas');
    expect(err.message).toMatch(/could not pay for the transaction/i);
    expect(err.message).toMatch(/nothing was sent/i);
  });

  it('sends from the derived account and returns its hash (positive)', async () => {
    const hash = await sendAs(ctx(), { to: ENGINE, data: '0x1234', label: 'bet' });

    expect(hash).toBe('0xhash');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: ENGINE, data: '0x1234' });
  });

  it('calls an unobserved outcome pending, not failed (negative)', async () => {
    // The transaction is on the wire. Reporting failure here is what makes someone bet twice.
    rpc.waitForTransactionReceipt.mockRejectedValue(new Error('timeout'));
    const err = (await sendAs(ctx(), {
      to: ENGINE,
      data: '0x1234',
      label: 'bet',
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('pending');
    expect(err.message).toMatch(/not settled yet/i);
    expect(err.message).not.toMatch(/nothing was/i);
  });
});
