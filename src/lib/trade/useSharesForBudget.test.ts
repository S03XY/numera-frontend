// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
vi.mock('@/lib/chain/evm', () => ({ publicClient: () => ({ readContract }) }));

const { solveSharesForBudget } = await import('./useSharesForBudget');

const ONE = 1_000_000n; // one whole share / one dollar, at 6 decimals

const BOOK = {
  engine: '0xeeee111111111111111111111111111111111111',
  marketId: '1',
  outcomeIndex: 0,
  side: 'buy' as const,
  decimals: 6,
};

/**
 * A convex book: `perShare` at the margin, rising with size.
 *
 * Convexity is the whole difficulty. A linear book would invert in one division; a real LS-LMSR
 * charges more per share the more you buy, so the marginal price the solver opens from always
 * understates the bill and the first guess is always too big.
 */
function book(perShare = 0.6, curvature = 0) {
  return ({ args }: { args: readonly unknown[] }) => {
    const shares = Number(args[2] as bigint) / 1e6;
    return BigInt(Math.round((perShare * shares + curvature * shares * shares) * 1e6));
  };
}

const dollars = (n: bigint) => Number(n) / 1e6;

beforeEach(() => {
  readContract.mockReset();
});

describe('solveSharesForBudget', () => {
  it('spends the target and answers in shares (positive)', async () => {
    readContract.mockImplementation(book(0.6));
    const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });

    // $99 of shares at 60c is 165 of them.
    expect(out).toEqual({ shares: 165n * ONE, cost: 99n * ONE });
  });

  it('never returns a size that costs more than the budget (REGRESSION)', async () => {
    // The one property the whole design rests on. The cap sent on chain is the budget itself, so a
    // size quoted above it is not a bad estimate — it is a transaction that reverts, having burned
    // the gas we sponsored for it.
    for (const curvature of [0, 0.0005, 0.005, 0.02, 0.2]) {
      readContract.mockImplementation(book(0.6, curvature));
      const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });
      expect(out, `curvature ${curvature}`).not.toBeNull();
      expect(out!.cost, `curvature ${curvature}`).toBeLessThanOrEqual(100n * ONE);
    }
  });

  it('lands within a basis point or two on a realistically gentle book (positive)', async () => {
    // The normal case: an order whose curvature adds about 1% to the bill. Over that range the
    // cost function is very nearly linear, so a single secant step is enough — the loop exists for
    // the pathological book, not this one.
    readContract.mockImplementation(book(0.6, 0.00004));
    const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });

    expect(dollars(out!.cost)).toBeGreaterThan(98.9);
    // At or under the target, so the full 1% of headroom the trader asked for survives.
    expect(dollars(out!.cost)).toBeLessThanOrEqual(99);
  });

  it('reads the chain a handful of times, not dozens (efficiency)', async () => {
    // This runs on every settled keystroke. A bisection that always burned its full budget of
    // steps would put twenty `eth_call`s behind each one.
    readContract.mockImplementation(book(0.6, 0.00004));
    await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });

    // The probe, plus two secant steps.
    expect(readContract.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stays bounded even on a book it cannot converge on (negative)', async () => {
    // A curve steep enough to defeat the secant still costs a fixed, small number of reads: the
    // step cap is what stops a pathological book turning one keystroke into a stall.
    readContract.mockReset();
    readContract.mockImplementation(book(0.6, 0.2));
    const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });

    expect(readContract.mock.calls.length).toBeLessThanOrEqual(7);
    // ...and what comes back is still affordable, just smaller than asked for.
    expect(out!.cost).toBeLessThanOrEqual(99n * ONE);
  });

  it('aims at the target, leaving the headroom unspent (positive)', async () => {
    // The slippage tolerance is taken OUT of the budget rather than added on top, because the cap
    // has to stay at or below the trader's balance for a "100%" button to be a valid trade.
    readContract.mockImplementation(book(0.5));
    const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 95n * ONE });

    expect(out!.cost).toBe(95n * ONE);
    expect(out!.shares).toBe(190n * ONE);
  });

  it('approaches the cap from above, never from below (positive)', async () => {
    // The opening estimate comes from the price of a single share, which on a convex book is the
    // cheapest any share will ever be — so the first size quoted is too expensive and every
    // subsequent one walks down. Every value that gets rejected was unaffordable, never a bargain
    // that got discarded.
    const sizes: number[] = [];
    const costs: number[] = [];
    readContract.mockImplementation((call: { args: readonly unknown[] }) => {
      sizes.push(Number(call.args[2] as bigint) / 1e6);
      const cost = book(0.6, 0.002)(call);
      costs.push(dollars(cost));
      return cost;
    });
    const out = await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE });

    // First call is the one-share probe; the second is the estimate built from it, and it is over.
    expect(sizes[0]).toBe(1);
    expect(costs[1]).toBeGreaterThan(99);
    expect(sizes[1]).toBeGreaterThan(Number(out!.shares) / 1e6);
  });

  it('returns nothing when the book prices at zero (negative)', async () => {
    // A quote of zero would make the opening estimate a division by zero, and any size "affordable".
    readContract.mockResolvedValue(0n);
    expect(await solveSharesForBudget({ ...BOOK, budget: 100n * ONE, target: 99n * ONE })).toBeNull();
  });

  it('returns nothing when not even the smallest size fits (negative)', async () => {
    // A budget under the price of a single base unit of shares. Better to say the trade cannot be
    // sized than to offer a zero-share bet for the engine to reject.
    readContract.mockImplementation(book(5));
    expect(await solveSharesForBudget({ ...BOOK, budget: 1n, target: 1n })).toBeNull();
  });

  it('clears the engine floor when the target sits right on it (REGRESSION)', async () => {
    // Found by probing the live engine. A bet at the minimum has a target equal to the floor, and
    // the search approaches from above and stops just *under* it — $4.9963 against a $5 floor,
    // which the engine rejects as `AmountBelowMin` after the trader has already signed. The answer
    // has to land in the band between the floor and the cap, not merely near it.
    readContract.mockImplementation(book(0.6));
    const floor = 5n * ONE;
    const out = await solveSharesForBudget({
      ...BOOK,
      budget: (505n * ONE) / 100n,
      target: floor,
      floor,
    });

    expect(out).not.toBeNull();
    expect(out!.cost).toBeGreaterThanOrEqual(floor);
    expect(out!.cost).toBeLessThanOrEqual((505n * ONE) / 100n);
  });

  it('refuses when the floor and the cap leave no room (negative)', async () => {
    // A budget of exactly the floor: the cost must be at least $5 and at most $5, to the base unit.
    // No discrete share count lands there, and offering one anyway is a guaranteed rejection — so
    // the ticket asks for a percent more, and this is what makes that necessary rather than fussy.
    readContract.mockImplementation(book(0.6));
    const floor = 5n * ONE;
    const out = await solveSharesForBudget({ ...BOOK, budget: floor, target: floor, floor });

    expect(out === null || (out.cost >= floor && out.cost <= floor)).toBe(true);
  });

  it('quotes the complement when shorting (positive)', async () => {
    // NO is `buyComplement` — a different function on a different basket, and sizing it against
    // `quoteBuy` would price one leg of a bet the trader is not placing.
    readContract.mockImplementation(book(0.4));
    await solveSharesForBudget({ ...BOOK, side: 'short', budget: 10n * ONE, target: 10n * ONE });

    expect(readContract.mock.calls[0][0].functionName).toBe('quoteBuyComplement');
  });
});
