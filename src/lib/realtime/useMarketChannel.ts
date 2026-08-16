'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/hooks/useMarkets';
import { QUOTE_QUERY_PREFIXES } from '@/lib/trade/refresh';
import type { Market } from '@/lib/api/types';
import {
  getSocket,
  RealtimeEvent,
  type MarketStatusPayload,
  type PricePayload,
  type RealtimeMessage,
  type TradePayload,
} from './socket';

export interface MarketChannelState {
  connected: boolean;
  /** Most recent trades pushed since mount (newest first), capped. */
  liveTrades: TradePayload[];
}

const MAX_LIVE_TRADES = 30;

/**
 * Subscribes to one market's realtime stream and folds updates into the React
 * Query cache, so every component reading the market re-renders with live data.
 *
 * Two correctness requirements this handles explicitly:
 *  1. **Re-subscribe on reconnect.** Rooms live on the server per-connection, so
 *     after a drop the socket is in no rooms; without re-emitting `subscribe`
 *     the UI would silently go stale while still looking "connected".
 *  2. **Refetch after a gap.** Events during a disconnect are not replayed, so
 *     the snapshot is invalidated on reconnect to close the hole.
 */
export function useMarketChannel(marketRef: string | undefined): MarketChannelState {
  const queryClient = useQueryClient();
  const [connected, setConnected] = React.useState(false);
  const [liveTrades, setLiveTrades] = React.useState<TradePayload[]>([]);

  React.useEffect(() => {
    if (!marketRef) return;
    const socket = getSocket();
    const subscribe = () => socket.emit('subscribe', { marketRef });

    const onConnect = () => {
      setConnected(true);
      subscribe();
      // Events missed while disconnected are never replayed — resync the snapshot.
      void queryClient.invalidateQueries({ queryKey: queryKeys.market(marketRef) });
    };
    const onDisconnect = () => setConnected(false);

    /**
     * The open ticket's quote, re-read because the book moved.
     *
     * This is the push half of quote freshness, and the half that does the real work: the server
     * knows a trade happened the instant it happens, so the alternative is waiting out a timer to
     * discover something we were already told. It also cannot be replaced by a faster timer, which
     * would only mean more reads that mostly learn nothing changed. See `lib/trade/refresh.ts`.
     *
     * Invalidation rather than a cache write: a quote is a pure function of the chain, not
     * something the socket carries, so the only honest response to "the book moved" is to ask the
     * engine again. Only the ticket's currently-mounted query is active, so this is one `eth_call`
     * and nothing at all when the panel is closed.
     */
    const requoteFromChain = () => {
      for (const prefix of QUOTE_QUERY_PREFIXES) {
        void queryClient.invalidateQueries({ queryKey: prefix });
      }
    };

    const onPrice = (msg: RealtimeMessage<PricePayload>) => {
      queryClient.setQueryData<Market>(queryKeys.market(marketRef), (prev) => {
        if (!prev) return prev;
        const prices = msg.data?.prices;
        if (!Array.isArray(prices)) return prev;
        return {
          ...prev,
          outcomes: prev.outcomes.map((o) =>
            prices[o.index] === undefined ? o : { ...o, priceWad: prices[o.index] },
          ),
        };
      });
      // A price move IS a curve move: the per-share figures on the ticket come from the market
      // snapshot above, but the size a budget buys comes from the engine and has to be re-solved.
      requoteFromChain();
    };

    const onTrade = (msg: RealtimeMessage<TradePayload>) => {
      const trade = msg.data;
      if (!trade?.txHash) return;
      setLiveTrades((prev) => {
        // Guard against duplicates from a reconnect/replay.
        if (prev.some((t) => t.txHash === trade.txHash && t.outcomeIndex === trade.outcomeIndex)) {
          return prev;
        }
        return [trade, ...prev].slice(0, MAX_LIVE_TRADES);
      });
      // Belt and braces with `onPrice`: a fill always moves the book, and whether a price event
      // accompanies it is the backend's business rather than something to depend on here.
      requoteFromChain();
    };

    const onStatus = (msg: RealtimeMessage<MarketStatusPayload>) => {
      queryClient.setQueryData<Market>(queryKeys.market(marketRef), (prev) =>
        prev
          ? {
              ...prev,
              status: msg.data.status,
              tradingOpen: false,
              winningOutcomeId: msg.data.winningOutcomeId ?? prev.winningOutcomeId,
            }
          : prev,
      );
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(RealtimeEvent.Price, onPrice);
    socket.on(RealtimeEvent.Trade, onTrade);
    socket.on(RealtimeEvent.MarketStatus, onStatus);

    // Already connected when this mounted (shared socket) — subscribe now.
    // The state update is deferred to a microtask rather than run in the effect
    // body, which would cascade an extra render pass on every mount.
    let queued = false;
    if (socket.connected) {
      queued = true;
      subscribe();
      queueMicrotask(() => {
        if (queued) setConnected(true);
      });
    }

    return () => {
      queued = false;
      socket.emit('unsubscribe', { marketRef });
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(RealtimeEvent.Price, onPrice);
      socket.off(RealtimeEvent.Trade, onTrade);
      socket.off(RealtimeEvent.MarketStatus, onStatus);
    };
  }, [marketRef, queryClient]);

  return { connected, liveTrades };
}
