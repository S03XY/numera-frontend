'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '@/lib/api/endpoints';
import { toBigInt } from '@/lib/format';
import { LIVE_REFETCH_MS } from '@/lib/hooks/useMarkets';
import { useExecutionAccounts } from '@/lib/execution/useExecutionAccounts';
import type { Position } from '@/lib/api/types';

/**
 * What the shielded accounts on this device hold.
 *
 * The server cannot derive this from a login — that link does not exist — so the browser supplies
 * its own account list and asks only for public on-chain figures. That asymmetry is the product
 * rather than a limitation.
 *
 * Read only by the market a position belongs to. There is no cross-market total anywhere in the
 * app: a screen that gathers every bet a person has made into one list is the one view this
 * product should not build, however well the addresses behind it are shielded.
 *
 * One query key for both consumers on that page — the ticket needs holdings to size a sale, the
 * position panel needs them to show and settle it — so a trade invalidates one thing and both
 * agree afterwards.
 */
export function usePositions() {
  // Derived from the market catalogue, not read from a stored list. See `useExecutionAccounts`:
  // the registry made a lost browser into lost positions, and told the backend which markets the
  // user was in.
  const accounts = useExecutionAccounts();

  const query = useQuery({
    queryKey: ['positions', accounts],
    queryFn: ({ signal }) => endpoints.positions.forAccounts(accounts, signal),
    enabled: accounts.length > 0,
    // Positions move from two directions this page cannot see: a bet that lands a moment after it
    // was submitted, and a market that settles while the tab is open and turns a holding into a
    // claim. Neither pushes an event here.
    refetchInterval: LIVE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  return { accounts, ...query };
}

export interface MarketHoldings {
  /** Non-empty positions in this market, in outcome order. */
  positions: Position[];
  /** Shares held per outcome index, base units. Missing means none. */
  sharesByOutcome: Map<number, bigint>;
  /** Mark-to-market value of everything held here, base units. */
  value: bigint;
  /** What it cost, base units — `value - basis` is the unrealised move. */
  basis: bigint;
  /** True once this browser has traded the market, even before the indexer catches up. */
  hasAccount: boolean;
}

/**
 * Holdings for one market.
 *
 * Zero-share rows are dropped rather than shown as an empty position: a trader who has sold out
 * holds nothing, and a zero line invites a sale the contract would revert.
 */
/**
 * Confirmed holdings only.
 *
 * Deliberately not merged with anything optimistic, and that is a safety property rather than an
 * oversight: the trade ticket sizes a sale from this, and shares the indexer has not written are
 * shares a sale would be rejected for. Predictions are drawn by {@link useVisibleHoldings}, which
 * is display-only. See `lib/optimistic/pending.ts`.
 */
export function useMarketHoldings(marketRef: string, hasAccount: boolean): MarketHoldings {
  const { data } = usePositions();

  return React.useMemo(() => {
    const positions = (data ?? [])
      .filter((p) => p.marketRef === marketRef && (toBigInt(p.shares) ?? 0n) > 0n)
      .sort((a, b) => a.outcomeIndex - b.outcomeIndex);

    // Summed, not assigned: one market can be held by more than one execution account after a
    // restore, and showing only the last one would understate what the trader can sell.
    const sharesByOutcome = new Map<number, bigint>();
    let value = 0n;
    let basis = 0n;
    for (const p of positions) {
      const shares = toBigInt(p.shares) ?? 0n;
      sharesByOutcome.set(p.outcomeIndex, (sharesByOutcome.get(p.outcomeIndex) ?? 0n) + shares);
      value += toBigInt(p.markToMarket) ?? 0n;
      basis += toBigInt(p.costBasis) ?? 0n;
    }

    return { positions, sharesByOutcome, value, basis, hasAccount };
  }, [data, marketRef, hasAccount]);
}
