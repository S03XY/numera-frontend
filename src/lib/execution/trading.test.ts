// @vitest-environment node
//
// Node rather than jsdom: real signing runs through @noble, which rejects Uint8Arrays minted in
// another realm. Same reason as keys.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { addressFor, ExecutionError } from './market-account';
import { ENGINE_ABI } from './relay';
import { claimWinnings, closePosition, openPosition, shieldBalance, type TradeContext } from './trading';
import type { ExecutionRoot } from './keys';

const ROOT = ('0x' + '11'.repeat(32)) as ExecutionRoot;
const MARKET = '767526dc-c2c6-447e-b4dc-b27ddc87104f';
const TOKEN = '0x2222222222222222222222222222222222222222';
const ENGINE = '0x1111111111111111111111111111111111111111';
const FORWARDER = '0x3333333333333333333333333333333333333333';
/** The trader's own wallet. Nothing here may ever route money through it. */
const USER_WALLET = '0x9d3591e2b1054670018717bCB0194BE65099B769';

let accountBalance: bigint;
let allowance: bigint;
let receiptStatus: string;
let pool: { withdraw: ReturnType<typeof vi.fn>; deposit: ReturnType<typeof vi.fn> };
let relay: { submit: ReturnType<typeof vi.fn>; permit: ReturnType<typeof vi.fn> };

function rpc() {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'balanceOf':
          return accountBalance;
        case 'allowance':
          return allowance;
        case 'nonces':
          return 0n;
        case 'name':
          return 'Numera Test USD';
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status: receiptStatus })),
  };
}

function ctx(): TradeContext {
  return {
    pool: pool as never,
    root: ROOT,
    gas: { ensure: vi.fn(async () => undefined) },
    marketRef: MARKET,
    token: TOKEN,
    relay: relay as never,
    rpc: rpc() as never,
    chainId: 10143,
    forwarder: FORWARDER,
    engine: ENGINE,
  };
}

/** What the relayer was actually asked to submit, decoded. */
function submitted() {
  const payload = relay.submit.mock.calls[0][0];
  return {
    payload,
    call: decodeFunctionData({ abi: ENGINE_ABI, data: payload.request.data as `0x${string}` }),
  };
}

beforeEach(() => {
  accountBalance = 0n;
  allowance = 0n;
  receiptStatus = 'success';
  pool = {
    withdraw: vi.fn(async () => undefined),
    deposit: vi.fn(async () => undefined),
  };
  relay = {
    submit: vi.fn(async () => ({ hash: '0xhash' })),
    permit: vi.fn(async () => ({ hash: '0xpermit' })),
  };
});

describe('opening a position', () => {
  it('trades as the derived account, never the trader’s wallet (REGRESSION)', async () => {
    // The entire privacy claim. If the signer were ever the user's own address, every position
    // would be publicly theirs.
    const result = await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });

    expect(result.account).toBe(addressFor({ root: ROOT, marketRef: MARKET }));
    expect(result.account.toLowerCase()).not.toBe(USER_WALLET.toLowerCase());
    expect(submitted().payload.request.from).toBe(result.account);
  });

  it('withdraws only the shortfall (positive)', async () => {
    // Crossing the pool is the expensive leg. An account holding change from an earlier trade
    // should fund the next one with no crossing at all.
    accountBalance = 4_000_000n;
    const result = await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });

    expect(result.withdrawn).toBe(7_000_000n);
    expect(pool.withdraw.mock.calls[0][0]).toEqual({
      token: TOKEN,
      amount: 7_000_000n,
      recipient: result.account,
    });
  });

  it('crosses the pool not at all when the account already holds enough (positive)', async () => {
    accountBalance = 50_000_000n;
    const result = await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });

    expect(result.withdrawn).toBe(0n);
    expect(pool.withdraw).not.toHaveBeenCalled();
    expect(relay.submit).toHaveBeenCalledTimes(1);
  });

  it('draws the larger funding amount when one is asked for (positive)', async () => {
    await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
      funding: 100_000_000n,
    });
    expect(pool.withdraw.mock.calls[0][0].amount).toBe(100_000_000n);
  });

  it('withdraws to the market account and nowhere else (REGRESSION)', async () => {
    // A withdrawal to the user's own address would put the collateral — and then the position —
    // under a public identity.
    const result = await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });
    expect(pool.withdraw.mock.calls[0][0].recipient).toBe(result.account);
  });

  it('encodes buy for a long and buyComplement for a short (positive)', async () => {
    await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });
    expect(submitted().call.functionName).toBe('buy');

    relay.submit.mockClear();
    await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
      complement: true,
    });
    expect(submitted().call.functionName).toBe('buyComplement');
  });

  it('bundles an approval only when the allowance is short (positive)', async () => {
    // `permit` is a signature, which is the only reason an account with no gas can approve at all.
    // Sending one when the allowance already covers the trade wastes gas on every single bet.
    allowance = 0n;
    await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });
    expect(submitted().payload.permit).toBeDefined();

    relay.submit.mockClear();
    allowance = (1n << 200n);
    await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });
    expect(submitted().payload.permit).toBeUndefined();
  });

  it('approves from the market account, not the user (REGRESSION)', async () => {
    const result = await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    });
    expect(submitted().payload.permit?.owner).toBe(result.account);
  });

  it('refuses zero and oversized amounts before touching the pool (negative)', async () => {
    const base = { marketId: 1n, outcomeId: 0n, sharesOut: 20_000_000n };
    await expect(openPosition(ctx(), { ...base, maxCost: 0n })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(openPosition(ctx(), { ...base, maxCost: 1n << 121n })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      openPosition(ctx(), { ...base, sharesOut: 0n, maxCost: 1_000_000n }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(pool.withdraw).not.toHaveBeenCalled();
  });

  it('says the balance is untouched when the pool refuses (negative)', async () => {
    pool.withdraw.mockRejectedValue(new Error('relayer down'));
    const err = (await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('pool');
    expect(err.message).toMatch(/private balance is untouched/i);
    expect(relay.submit).not.toHaveBeenCalled();
  });
});

describe('closing a position', () => {
  it('closes a short atomically through sellComplement (REGRESSION)', async () => {
    // Selling the legs separately would be one relayed transaction each, and a revert partway
    // through leaves an unbalanced remainder that is no longer a hedge.
    await closePosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesIn: 20_000_000n,
      minRefund: 9_000_000n,
      complement: true,
    });

    expect(relay.submit).toHaveBeenCalledTimes(1);
    expect(submitted().call.functionName).toBe('sellComplement');
  });

  it('uses a plain sell for a long (positive)', async () => {
    await closePosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesIn: 20_000_000n,
      minRefund: 9_000_000n,
    });
    expect(submitted().call.functionName).toBe('sell');
  });

  it('carries the slippage floor the caller asked for (safety)', async () => {
    await closePosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesIn: 20_000_000n,
      minRefund: 9_000_000n,
    });
    expect(submitted().call.args?.[3]).toBe(9_000_000n);
  });

  it('shields the proceeds only when asked (positive)', async () => {
    accountBalance = 9_500_000n;
    await closePosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesIn: 20_000_000n,
      minRefund: 9_000_000n,
    });
    expect(pool.deposit).not.toHaveBeenCalled();

    await closePosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesIn: 20_000_000n,
      minRefund: 9_000_000n,
      shield: true,
    });
    expect(pool.deposit).toHaveBeenCalledTimes(1);
  });
});

describe('claiming', () => {
  it('redeems and shields by default (positive)', async () => {
    accountBalance = 20_000_000n;
    await claimWinnings(ctx(), { marketId: 1n });

    expect(submitted().call.functionName).toBe('redeem');
    expect(pool.deposit).toHaveBeenCalledTimes(1);
  });

  it('deposits as the market account, into the user’s private balance (REGRESSION)', async () => {
    // Depositor and recipient are independent: the account signs, the user's private balance is
    // credited. A deposit signed by the user's own wallet would publish the link.
    //
    // Asserted through `wallet.account`, which is the shape the pool actually reads. The earlier
    // version of this test checked `wallet.address` — true of a bare signing account, and the
    // reason a wrong object passed here for days: live, it surfaced as "this wallet has no account
    // selected" from deep inside the SDK, on the one path no probe exercised.
    accountBalance = 20_000_000n;
    await claimWinnings(ctx(), { marketId: 1n });

    const sent = pool.deposit.mock.calls[0][0] as { wallet: { account: { address: string } } };
    expect(sent.wallet.account.address).toBe(addressFor({ root: ROOT, marketRef: MARKET }));
    expect(sent.wallet.account.address.toLowerCase()).not.toBe(USER_WALLET.toLowerCase());
  });
});

describe('getting the money back out', () => {
  /**
   * The return leg is the half of the design that is easiest to leave broken, because nothing
   * fails until a trader tries to get their winnings out — by which point the money is sitting in
   * an account that holds no gas and can never send a transaction of its own.
   */
  it('returns the balance by signature, never by transaction (REGRESSION)', () => {
    accountBalance = 20_000_000n;

    return claimWinnings(ctx(), { marketId: 1n }).then(() => {
      expect(pool.deposit).toHaveBeenCalledTimes(1);
      const sent = pool.deposit.mock.calls[0][0] as { sponsored?: boolean; amount: bigint };
      // `sponsored` is the whole instruction: this account holds no native gas and never will, so
      // it must sign and have somebody else send. Dropping the flag would send it down the path
      // that tries to `approve` from an account with nothing to pay for it.
      expect(sent.sponsored).toBe(true);
      expect(sent.amount).toBe(20_000_000n);
    });
  });

  it('needs no separate approval step at all (REGRESSION)', async () => {
    // The previous pool pulled through Permit2, so this leg was three round trips: read the
    // allowance, relay a standalone permit, then deposit. Numera's entrypoint takes the permit
    // bundled into the same transaction, so a stale allowance can no longer strand a withdrawal.
    accountBalance = 20_000_000n;
    allowance = 0n;

    await claimWinnings(ctx(), { marketId: 1n });

    expect(relay.permit).not.toHaveBeenCalled();
    expect(pool.deposit).toHaveBeenCalledTimes(1);
  });

  it('leaves the money where it is when the return cannot be submitted (negative)', async () => {
    accountBalance = 20_000_000n;
    pool.deposit.mockRejectedValue(new Error('relayer down'));

    const err = (await claimWinnings(ctx(), { marketId: 1n }).catch((e) => e)) as ExecutionError;
    // The claim itself already succeeded, so the message has to say the money is safe. Reporting
    // this as a failed claim would invite the trader to repeat an operation that worked.
    expect(err.code).toBe('pool');
    expect(err.message).toMatch(/still in this market’s account/i);
    expect(err.message).toMatch(/nothing was lost/i);
  });
});

describe('claiming', () => {
  it('redeems and shields by default (positive)', async () => {
    accountBalance = 20_000_000n;
    await claimWinnings(ctx(), { marketId: 1n });

    expect(submitted().call.functionName).toBe('redeem');
    expect(pool.deposit).toHaveBeenCalledTimes(1);
  });

  it('deposits as the market account, into the user’s private balance (REGRESSION)', async () => {
    // Depositor and recipient are independent: the account signs, the user's private balance is
    // credited. A deposit signed by the user's own wallet would publish the link.
    //
    // Asserted through `wallet.account`, which is the shape the pool actually reads. The earlier
    // version of this test checked `wallet.address` — true of a bare signing account, and the
    // reason a wrong object passed here for days: live, it surfaced as "this wallet has no account
    // selected" from deep inside the SDK, on the one path no probe exercised.
    accountBalance = 20_000_000n;
    await claimWinnings(ctx(), { marketId: 1n });

    const sent = pool.deposit.mock.calls[0][0] as { wallet: { account: { address: string } } };
    expect(sent.wallet.account.address).toBe(addressFor({ root: ROOT, marketRef: MARKET }));
    expect(sent.wallet.account.address.toLowerCase()).not.toBe(USER_WALLET.toLowerCase());
  });
});


describe('shielding what is left', () => {
  it('reads the balance fresh rather than trusting a figure (REGRESSION)', async () => {
    // A sale settling in between would otherwise leave the difference behind as dust in an account
    // the trader has just been told is empty.
    accountBalance = 12_345_678n;
    const moved = await shieldBalance(ctx(), addressFor({ root: ROOT, marketRef: MARKET }));
    expect(moved).toBe(12_345_678n);
    expect(pool.deposit.mock.calls[0][0].amount).toBe(12_345_678n);
  });

  it('does nothing on an empty account (negative)', async () => {
    accountBalance = 0n;
    expect(await shieldBalance(ctx(), addressFor({ root: ROOT, marketRef: MARKET }))).toBe(0n);
    expect(pool.deposit).not.toHaveBeenCalled();
  });
});

describe('when the relayer will not take it', () => {
  it('says nothing was spent when the relayer is busy (REGRESSION)', async () => {
    // The relayer simulates before broadcasting, so its rejections are pre-broadcast by
    // construction — which makes "nothing happened" a promise this can actually keep.
    relay.submit.mockRejectedValue(new Error('Too many trades from this account'));
    const err = (await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    }).catch((e) => e)) as ExecutionError;

    expect(err.message).toMatch(/nothing was spent/i);
    expect(err.message).not.toMatch(/settled|pending/i);
  });

  it('tells the trader the price moved when the market refuses (negative)', async () => {
    relay.submit.mockRejectedValue(new Error('The market rejected this trade'));
    const err = (await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('rejected');
    expect(err.message).toMatch(/nothing was sent/i);
    expect(err.message).toMatch(/price may have moved/i);
  });

  it('treats a reverted receipt as a failure (REGRESSION)', async () => {
    // A transaction that lands and reverts still returns a hash. Reading only the hash is how a
    // rejected bet gets reported as placed.
    receiptStatus = 'reverted';
    const err = (await openPosition(ctx(), {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('rejected');
    expect(err.message).toMatch(/rejected by the market/i);
  });

  it('calls an unobserved outcome pending, not failed (REGRESSION)', async () => {
    // The transaction is on the wire. Reporting failure here is what makes someone bet twice.
    const c = ctx();
    (c.rpc as unknown as { waitForTransactionReceipt: ReturnType<typeof vi.fn> })
      .waitForTransactionReceipt.mockRejectedValue(new Error('timeout'));

    const err = (await openPosition(c, {
      marketId: 1n,
      outcomeId: 0n,
      sharesOut: 20_000_000n,
      maxCost: 11_000_000n,
    }).catch((e) => e)) as ExecutionError;

    expect(err.code).toBe('pending');
    expect(err.message).toMatch(/not settled yet/i);
    expect(err.message).not.toMatch(/nothing was/i);
  });
});
