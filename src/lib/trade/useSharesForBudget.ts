'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { parseAbi } from 'viem';
import { publicClient } from '@/lib/chain/evm';
import { QUOTE_REFRESH_MS } from './refresh';

/**
 * How many shares a given amount of collateral buys — solved against the engine's own quote.
 *
 * ## Why this has to be solved rather than computed
 *
 * The engine is exact-*output*: `buy(marketId, outcomeId, sharesOut, maxCost)` takes a share count
 * and charges whatever the curve says. A trader thinks in the other direction — "put $50 on
 * Argentina" — so the ticket has to invert the cost function to find the size that spends $50.
 *
 * LS-LMSR has no closed-form inverse. `b` is a function of `Σq`, so it moves as the order fills,
 * and the damping term and the spread move with it. Solving it in Solidity would mean a binary
 * search inside the transaction, and since we sponsor the gas — and Monad bills the *declared* gas
 * limit rather than what was used — that search would be paid for on every single bet. So it is
 * solved here, off-chain and for free, against the same `quoteBuy` the trade itself will charge.
 *
 * ## Why it converges in two or three reads
 *
 * `cost(s)` is monotonically increasing and very nearly linear over the range a single order
 * spans; the curvature only shows up once the order is a material fraction of the book. So a
 * secant step — scale the size by `target / cost` — lands within a basis point or two almost
 * immediately. The loop, and the bracket it keeps, are there for the pathological case.
 *
 * The first estimate comes from quoting a single share. That is the marginal price, which
 * understates what a large order pays, so the opening guess is always *high* and the iteration
 * walks it down. Approaching a spending cap from above is the safe direction: every intermediate
 * value that gets rejected was too expensive, never too cheap.
 *
 * ## The guarantee
 *
 * `floor <= cost <= budget`, checked on the value actually returned rather than inferred from the
 * arithmetic. A solve that cannot satisfy both returns `null` rather than a size that would be
 * rejected — over the cap reverts as `SlippageExceeded`, under the floor as `AmountBelowMin`, and
 * both cost the trader a signature and cost us the gas we sponsored.
 *
 * The ticket then sends `budget` itself as `maxCost`, so the number the trader typed is the number
 * the contract enforces — which is what makes a "100%" button safe to offer against a balance.
 */

const QUOTE_ABI = parseAbi([
  'function quoteBuy(uint256 marketId, uint256 outcomeId, uint256 sharesOut) view returns (uint256)',
  'function quoteBuyComplement(uint256 marketId, uint256 outcomeId, uint256 sharesOut) view returns (uint256)',
]);

const FUNCTION = { buy: 'quoteBuy', short: 'quoteBuyComplement' } as const;

export type BudgetSide = keyof typeof FUNCTION;

/** Close enough to stop: within 10 bps of the target spend. */
const TOLERANCE_BPS = 10n;
/** Steps before settling for the best size found. Two is the normal case; this is the guard rail. */
const MAX_STEPS = 6;

export interface BudgetSolution {
  /** Share count to send on chain, base units, or `null` when no size fits the budget. */
  shares: bigint | null;
  /** What the engine says that size costs — fee and spread included. Never above `budget`. */
  cost: bigint | null;
  isFetching: boolean;
  isError: boolean;
  /** When this solve landed, as epoch ms; `0` before the first one. Drives the countdown. */
  updatedAt: number;
  /** Re-solve now — the manual half of the refresh control. */
  refetch: () => void;
}

export interface SolveParams {
  engine: string;
  marketId: string;
  outcomeIndex: number;
  side: BudgetSide;
  /** The hard cap: what the trader typed, in collateral base units. */
  budget: bigint | null;
  /**
   * What to aim to spend — the budget less the slippage headroom.
   *
   * Held back rather than added on top, because the cap has to stay at or under the trader's own
   * balance for a "100%" button to mean anything. The unspent remainder is what absorbs a price
   * move between this quote and the block that fills it.
   */
  target: bigint | null;
  /**
   * The engine's minimum trade cost, which the solved size must also CLEAR.
   *
   * The constraint is two-sided and the sides pull against each other: at least this, at most the
   * budget. Aiming at the target and approaching from above lands just *under* it — fine when the
   * target is well clear of the floor, and a rejected trade when it is not, because no discrete
   * share count costs exactly the floor.
   */
  floor?: bigint;
  /** Collateral decimals, which is also the share scale the engine uses. */
  decimals: number;
  enabled?: boolean;
}

export async function solveSharesForBudget(
  args: Omit<SolveParams, 'enabled'> & { budget: bigint; target: bigint },
): Promise<{ shares: bigint; cost: bigint } | null> {
  const { engine, marketId, outcomeIndex, side, budget, target, decimals, floor = 0n } = args;

  const quote = (shares: bigint) =>
    publicClient().readContract({
      address: engine as `0x${string}`,
      abi: QUOTE_ABI,
      functionName: FUNCTION[side],
      args: [BigInt(marketId), BigInt(outcomeIndex), shares],
    }) as Promise<bigint>;

  const oneShare = 10n ** BigInt(decimals);
  const marginal = await quote(oneShare);
  // A market whose shares are free — or whose quote failed to a zero — has nothing to size against.
  if (marginal <= 0n) return null;

  // The bracket. `lo` is the largest size proved to sit at or under the target, `hi` the smallest
  // proved above it. Every step is kept strictly inside it, which is what stops a secant from
  // oscillating on a sharply convex book — and it means the answer is never a size that was merely
  // *assumed* to fit: it was quoted, and its cost came back.
  //
  // The search aims at `target`, not `budget`. Stopping anywhere in between would still be
  // affordable, but it would quietly eat the slippage headroom the trader chose — a 1% tolerance
  // that turns out to be 0.4% is a tolerance that reverts.
  let lo = 0n;
  let hi: bigint | null = null;
  type Sized = { shares: bigint; cost: bigint };
  // The preferred answer: the largest size at or under the target.
  let best: Sized | null = null;
  // The answer when the floor puts the target out of reach, which is what a bet near the engine's
  // minimum looks like — the cheapest size that clears the floor without breaching the cap. Built
  // from overshoots the search produces anyway, so it costs no extra reads.
  let fallback: Sized | null = null;
  let shares = (target * oneShare) / marginal;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (shares <= 0n) break;
    const cost = await quote(shares);
    if (cost <= 0n) break;

    if (cost >= floor && cost <= budget && (fallback === null || cost < fallback.cost)) {
      fallback = { shares, cost };
    }

    if (cost <= target) {
      if (shares > lo) lo = shares;
      if (best === null || cost > best.cost) best = { shares, cost };
      // Spending what we set out to spend. Done.
      if (cost * 10_000n >= target * (10_000n - TOLERANCE_BPS)) break;
    } else if (hi === null || shares < hi) {
      hi = shares;
    }

    let next = (shares * target) / cost;
    // Outside what has been proved, or going backwards: bisect the bracket instead.
    if (hi !== null && next >= hi) next = lo + (hi - lo) / 2n;
    if (next <= lo) next = hi === null ? lo + lo / 2n + 1n : lo + (hi - lo) / 2n;
    if (next <= 0n || next === shares) break;
    shares = next;
  }

  // Both bounds re-checked on the value actually returned rather than inferred from the loop. Over
  // the cap is a revert; under the floor is a rejection. Either one costs the trader a signature
  // and costs us the gas we sponsored for it.
  if (best !== null && best.cost >= floor && best.cost <= budget) return best;
  if (fallback !== null) return fallback;

  // Converged just under the floor, and never quoted anything above it — which happens when the
  // very first estimate lands inside the tolerance band and the loop stops there, so the search
  // produced no overshoot for `fallback` to catch. That is precisely the shape of a bet at the
  // engine's minimum, so it is worth two more reads to step deliberately up into the band.
  if (best !== null && best.cost < floor && floor <= budget) {
    let up = (best.shares * floor) / best.cost + 1n;
    for (let i = 0; i < 2; i += 1) {
      const cost = await quote(up);
      if (cost >= floor && cost <= budget) return { shares: up, cost };
      if (cost > budget || cost <= 0n) break;
      up = (up * floor) / cost + 1n;
    }
  }
  return null;
}

export function useSharesForBudget(params: SolveParams): BudgetSolution {
  const { engine, marketId, outcomeIndex, side, budget, target, decimals, enabled = true } = params;

  const query = useQuery({
    queryKey: [
      'shares-for-budget',
      engine,
      marketId,
      outcomeIndex,
      side,
      budget?.toString() ?? null,
      target?.toString() ?? null,
      params.floor?.toString() ?? null,
    ],
    queryFn: () =>
      solveSharesForBudget({
        engine,
        marketId,
        outcomeIndex,
        side,
        budget: budget!,
        target: target!,
        floor: params.floor,
        decimals,
      }),
    enabled: enabled && Boolean(engine) && budget !== null && budget > 0n && target !== null && target > 0n,
    // Re-solved on the same tick as every other quote on this panel, and invalidated immediately
    // by the market socket when a trade actually moves the book. See `QUOTE_REFRESH_MS`.
    refetchInterval: QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    // Hold the previous size while a new one is solved. Without it every keystroke blanks the
    // quote panel and the whole ticket flickers between empty and priced.
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: 1,
  });

  return {
    shares: query.data?.shares ?? null,
    cost: query.data?.cost ?? null,
    isFetching: query.isFetching,
    isError: query.isError,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  };
}
