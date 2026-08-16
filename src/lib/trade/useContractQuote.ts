'use client';

import { useQuery } from '@tanstack/react-query';
import { parseAbi } from 'viem';
import { publicClient } from '@/lib/chain/evm';
import { QUOTE_REFRESH_MS } from './refresh';

/**
 * What the engine says a trade costs — read from the engine.
 *
 * ## Why this exists rather than reusing the ticket's own maths
 *
 * The ticket prices trades locally, in floating point, so the figure updates as you type without a
 * round trip. That is the right call for *display*. It is the wrong call for the slippage guard
 * that goes on chain, and the difference is not academic:
 *
 *  - the local curve does not know about the trading fee, so its total is ~1% low
 *  - it works in doubles against a contract doing 18-decimal fixed point
 *  - the spread carries a time term, so the number moves between render and block
 *
 * Any one of those makes `maxCost` land under what the engine charges, and the trade reverts with
 * `SlippageExceeded` — which reads to the trader as "the price moved", when in fact the two sides
 * were never computing the same number.
 *
 * The engine's `quoteBuy`/`quoteSell` are fee-inclusive and are the *same internal function the
 * trade itself calls*, so a guard derived from them differs from execution only by real price
 * movement — which is exactly what a slippage tolerance is for.
 */

const MIN_TRADE_ABI = parseAbi([
  'function minTradeCost(address token) view returns (uint256)',
]);

const QUOTE_ABI = parseAbi([
  'function quoteBuy(uint256 marketId, uint256 outcomeId, uint256 sharesOut) view returns (uint256)',
  'function quoteBuyComplement(uint256 marketId, uint256 outcomeId, uint256 sharesOut) view returns (uint256)',
  'function quoteSell(uint256 marketId, uint256 outcomeId, uint256 sharesIn) view returns (uint256)',
  'function quoteSellComplement(uint256 marketId, uint256 outcomeId, uint256 sharesIn) view returns (uint256)',
]);

export type QuoteSide = 'buy' | 'short' | 'sell' | 'sellShort';

const FUNCTION: Record<QuoteSide, 'quoteBuy' | 'quoteBuyComplement' | 'quoteSell' | 'quoteSellComplement'> = {
  buy: 'quoteBuy',
  short: 'quoteBuyComplement',
  sell: 'quoteSell',
  sellShort: 'quoteSellComplement',
};

export interface ContractQuote {
  /** Base units: what a buy costs, or what a sale pays. Both net of fees. */
  total: bigint | null;
  isFetching: boolean;
  isError: boolean;
  /** When this figure was read, as epoch ms; `0` before the first read. Drives the countdown. */
  updatedAt: number;
  /** Re-read now — the manual half of the refresh control. */
  refetch: () => void;
}

export function useContractQuote(params: {
  engine: string;
  marketId: string;
  outcomeIndex: number;
  side: QuoteSide;
  /** Share quantity in base units, or `null` while the input is empty or invalid. */
  shares: bigint | null;
  enabled?: boolean;
}): ContractQuote {
  const { engine, marketId, outcomeIndex, side, shares, enabled = true } = params;

  const query = useQuery({
    queryKey: ['contract-quote', engine, marketId, outcomeIndex, side, shares?.toString() ?? null],
    queryFn: () =>
      publicClient().readContract({
        address: engine as `0x${string}`,
        abi: QUOTE_ABI,
        functionName: FUNCTION[side],
        args: [BigInt(marketId), BigInt(outcomeIndex), shares!],
      }),
    enabled: enabled && Boolean(engine) && shares !== null && shares > 0n,
    // Ten seconds, and see `QUOTE_REFRESH_MS` for why that number rather than a faster one — the
    // socket already covers the case a timer is bad at.
    refetchInterval: QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });

  return {
    total: query.data ?? null,
    isFetching: query.isFetching,
    isError: query.isError,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  };
}

/**
 * The smallest trade this engine will accept, in collateral base units.
 *
 * Not a UX preference — it is the bound that makes sponsored gas safe to offer, because every
 * relayed trade has to carry a fee worth more than the gas of relaying it. But a trader does not
 * care why: they care that the ticket tells them *before* they commit, rather than letting the
 * engine refuse and blaming the price.
 *
 * Read from the chain rather than configured, because it is settable by the fee manager and a
 * hardcoded copy would start lying the first time it changed.
 */
export function useMinTradeCost(engine: string, token: string): bigint | null {
  const query = useQuery({
    queryKey: ['min-trade-cost', engine, token],
    queryFn: () =>
      publicClient().readContract({
        address: engine as `0x${string}`,
        abi: MIN_TRADE_ABI,
        functionName: 'minTradeCost',
        args: [token as `0x${string}`],
      }),
    enabled: Boolean(engine) && Boolean(token),
    // Changes about as often as a deployment does.
    staleTime: 5 * 60_000,
  });
  return query.data ?? null;
}
