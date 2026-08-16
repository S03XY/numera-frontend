'use client';

import * as React from 'react';
import { toBigInt } from '@/lib/format';
import { usePositions } from '@/lib/hooks/usePositions';
import type { Market, Position } from '@/lib/api/types';
import {
  applyPending,
  pendingPositions,
  positionSubject,
  useAllPending,
  type PendingEntry,
} from './pending';

/**
 * What to *show* a trader about their position, as opposed to what to act on.
 *
 * The split matters. `useMarketHoldings` answers "how many shares may this account sell", and that
 * question has one correct answer: the confirmed one, because a sale of shares the engine has not
 * credited is a rejected transaction. This answers "what did that bet do", and there the honest
 * answer includes a bet that has landed on chain and is waiting on our own indexer.
 *
 * So predictions are drawn here and nowhere that decides anything.
 */

export interface VisibleHoldings {
  positions: Position[];
  /** True while any figure on screen is a prediction rather than the server's answer. */
  pending: boolean;
}

/** Read back the parts of a subject key, for a prediction with no server row to attach to. */
function parseSubject(subject: string): { account: string; outcomeIndex: number } | null {
  // `position:<account>:<marketRef>:<outcome>` — the market is matched by the caller's own key, so
  // only the ends are needed here.
  const parts = subject.split(':');
  if (parts.length !== 4 || parts[0] !== 'position') return null;
  const outcomeIndex = Number(parts[3]);
  return Number.isInteger(outcomeIndex) ? { account: parts[1], outcomeIndex } : null;
}

export function useVisibleHoldings(market: Market): VisibleHoldings {
  const { data, accounts } = usePositions();
  const all = useAllPending(pendingPositions);
  const marketRef = market.id;

  /*
    Retire predictions the server has caught up on.

    In an effect because it writes to a store, and a render must not. The merge below is written to
    stand on its own — an entry whose witness no longer matches the server is ignored there too — so
    this is housekeeping rather than the mechanism, and a missed pass costs nothing but memory.
  */
  React.useEffect(() => {
    if (!data) return;
    const confirmed = new Map<string, bigint>();
    for (const p of data) {
      confirmed.set(positionSubject(p.account, p.marketRef, p.outcomeIndex), toBigInt(p.shares) ?? 0n);
    }
    pendingPositions.reconcile((subject) => confirmed.get(subject));
  }, [data]);

  return React.useMemo(() => {
    const server = (data ?? []).filter((p) => p.marketRef === marketRef);
    const forThisMarket = all.filter((e) => e.subject.includes(`:${marketRef}:`));
    if (forThisMarket.length === 0) {
      return {
        positions: server
          .filter((p) => (toBigInt(p.shares) ?? 0n) > 0n)
          .sort((a, b) => a.outcomeIndex - b.outcomeIndex),
        pending: false,
      };
    }

    let touched = false;
    const seen = new Set<string>();

    // Existing rows, moved.
    const merged: Position[] = server.map((p) => {
      const subject = positionSubject(p.account, p.marketRef, p.outcomeIndex);
      seen.add(subject);
      const shares = toBigInt(p.shares) ?? 0n;
      // Witness check, per entry: the whole point is that a prediction stops applying the instant
      // the server's own figure moves, whether or not the reconcile pass has run.
      const live = forThisMarket.filter((e) => e.subject === subject && e.witness === shares);
      if (live.length === 0) return p;
      touched = true;
      const next = applyPending(live, {
        value: shares,
        secondary: toBigInt(p.costBasis) ?? 0n,
        collected: p.redeemed,
      });
      return {
        ...p,
        shares: next.value.toString(),
        costBasis: next.secondary.toString(),
        redeemed: next.collected,
        // Left as the server sent it. A valuation is a price the server holds applied to a size it
        // has not seen, and a confidently wrong number beside a right one reads as a pricing bug
        // rather than as a pending write.
        markToMarket: p.markToMarket,
      };
    });

    /*
      A first bet on an outcome, which has no row to move.

      This is the case the whole file exists for. Everything else is a number ticking up; this is
      the difference between "your bet is there" and an empty panel that says nothing happened,
      shown at the exact moment somebody is least sure their money went anywhere.

      Restricted to accounts this browser derives, so nothing in the store can put a position on
      screen that is not the user's.
    */
    const mine = new Set(accounts.map((a) => a.toLowerCase()));
    const shape = server[0];
    for (const entry of forThisMarket) {
      if (seen.has(entry.subject) || entry.witness !== 0n || entry.delta <= 0n) continue;
      const parsed = parseSubject(entry.subject);
      if (!parsed || !mine.has(parsed.account)) continue;
      seen.add(entry.subject);
      touched = true;
      merged.push(conjure(market, shape, parsed.account, parsed.outcomeIndex, entry));
    }

    return {
      positions: merged
        .filter((p) => (toBigInt(p.shares) ?? 0n) > 0n)
        .sort((a, b) => a.outcomeIndex - b.outcomeIndex),
      pending: touched,
    };
  }, [data, all, accounts, market, marketRef]);
}

/**
 * Build the row the indexer is about to write.
 *
 * Every field either comes from the market the caller already has, or is a figure this prediction
 * genuinely knows. Nothing is invented: `markToMarket` is null rather than guessed, and the
 * realised P&L of a position that has never been closed is zero.
 */
function conjure(
  market: Market,
  shape: Position | undefined,
  account: string,
  outcomeIndex: number,
  entry: PendingEntry,
): Position {
  return {
    marketRef: market.id,
    marketTitle: market.title,
    marketStatus: market.status,
    engine: shape?.engine ?? market.engine,
    marketAddress: market.address,
    marketOnChainId: market.marketId,
    collateral: market.collateral,
    account,
    outcomeIndex,
    outcomeLabel:
      market.outcomes.find((o) => o.index === outcomeIndex)?.label ?? `Outcome ${outcomeIndex + 1}`,
    shares: entry.delta.toString(),
    costBasis: (entry.secondary < 0n ? 0n : entry.secondary).toString(),
    realizedPnl: '0',
    redeemed: false,
    currentPriceWad: null,
    winningOutcomeId: market.winningOutcomeId,
    markToMarket: null,
  };
}
