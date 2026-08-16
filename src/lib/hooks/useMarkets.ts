'use client';

import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { endpoints } from '@/lib/api/endpoints';
import { useNow } from '@/lib/useNow';
import type { Candle, ListMarketsParams } from '@/lib/api/types';

/**
 * How often a list that nobody is pushing to should re-ask.
 *
 * Only the market **detail** page has a realtime channel. Everything else — the
 * board, the portfolio, the trade tape — is plain HTTP, and with the default
 * `staleTime` those screens simply never updated: a bet that settled minutes ago
 * was still missing, which reads as a broken product rather than a stale cache.
 *
 * Four seconds is chosen against Monad's block time (~0.5s) and the indexer's
 * own cadence: fast enough that a trade appears while the user is still looking
 * at the screen, slow enough not to hammer the API from every open tab.
 */
export const LIVE_REFETCH_MS = 4_000;

export const queryKeys = {
  markets: (params: ListMarketsParams) => ['markets', params] as const,
  market: (id: string) => ['market', id] as const,
  categories: () => ['categories'] as const,
  resolutionTerms: (id: string) => ['resolution-terms', id] as const,
  trades: (marketRef: string) => ['trades', marketRef] as const,
  candles: (marketRef: string, outcome: number, range: ChartRange) =>
    ['candles', marketRef, outcome, range] as const,
};

/**
 * Windows offered on the price chart, and how each is sampled.
 *
 * Bucket size is chosen so a window lands between roughly 40 and 100 points: fewer and the line
 * is a polygon, more and the detail is below a pixel and costs bandwidth for nothing. The
 * backend whitelists these interval strings — an unlisted one is rejected rather than
 * interpolated into SQL.
 */
export const CHART_RANGES = {
  '1H': { hours: 1, interval: '1m' },
  '6H': { hours: 6, interval: '5m' },
  '1D': { hours: 24, interval: '15m' },
  '1W': { hours: 24 * 7, interval: '1h' },
} as const;

export type ChartRange = keyof typeof CHART_RANGES;

export interface OutcomeSeries {
  outcomeIndex: number;
  candles: Candle[];
}

/**
 * Price history for every outcome, one query per outcome.
 *
 * The endpoint takes a single `outcome`, so a binary market costs two requests and a four-way
 * costs four. They run in parallel and cache independently, which is the point of splitting them
 * — switching range refetches only what changed, and a market with one very active outcome does
 * not invalidate the quiet ones.
 *
 * `from` is bucketed to the interval rather than to the millisecond. An unrounded boundary would
 * make the query key change on every render and refetch forever.
 */
export function useMarketCandles(marketRef: string, outcomeCount: number, range: ChartRange) {
  const { hours, interval } = CHART_RANGES[range];
  const bucketMs = hours <= 1 ? 60_000 : hours <= 6 ? 300_000 : hours <= 24 ? 900_000 : 3_600_000;

  // The shared ticker rather than `Date.now()`. Reading the clock during render is impure — the
  // window would differ between two renders of the same frame — and bucketing alone does not fix
  // that, it only makes the disagreement rare enough to be hard to reproduce.
  const now = useNow();
  const from =
    now === null ? null : new Date(Math.ceil(now / bucketMs) * bucketMs - hours * 3_600_000).toISOString();

  const results = useQueries({
    queries: Array.from({ length: Math.max(0, outcomeCount) }, (_, outcome) => ({
      queryKey: [...queryKeys.candles(marketRef, outcome, range), from],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        endpoints.prices.candles(marketRef, { interval, outcome, from: from!, limit: 500 }, signal),
      enabled: Boolean(marketRef) && outcomeCount > 0 && from !== null,
      refetchInterval: LIVE_REFETCH_MS,
      refetchIntervalInBackground: false,
      staleTime: 0,
    })),
  });

  return {
    series: results.map((r, outcomeIndex): OutcomeSeries => ({
      outcomeIndex,
      candles: r.data ?? [],
    })),
    // Pending only while nothing has arrived: one slow outcome must not blank a chart that can
    // already draw the others.
    isPending: results.length > 0 && results.every((r) => r.isPending),
    isError: results.some((r) => r.isError),
  };
}

export function useMarkets(params: ListMarketsParams = {}) {
  return useQuery({
    queryKey: queryKeys.markets(params),
    queryFn: ({ signal }) => endpoints.markets.list(params, signal),
    // The board carries live prices and pot sizes. No socket covers it, so it
    // polls; `staleTime: 0` keeps a remount from serving a cached snapshot.
    refetchInterval: LIVE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function useMarket(id: string) {
  return useQuery({
    queryKey: queryKeys.market(id),
    queryFn: ({ signal }) => endpoints.markets.byId(id, signal),
    enabled: Boolean(id),
    // Polls *as well as* the socket. The channel pushes price and trade events,
    // but a dropped connection or a missed event would otherwise leave this
    // screen confidently wrong until navigation.
    refetchInterval: LIVE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/**
 * What proposing or disputing this market costs right now.
 *
 * Only fetched when asked for, because it is a live chain read behind the API rather than a
 * database field — the bond scales with the pot and the reward with the fees the market has earned,
 * so neither can be cached without quoting a price we might not honour.
 *
 * Refetched on a slow interval rather than the live one: these move with trading, which has already
 * stopped by the time anybody is looking at this.
 */
export function useResolutionTerms(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.resolutionTerms(id),
    queryFn: ({ signal }) => endpoints.markets.resolutionTerms(id, signal),
    enabled: Boolean(id) && enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.categories(),
    queryFn: ({ signal }) => endpoints.markets.categories(signal),
    // The catalog changes rarely; don't refetch it on every navigation.
    staleTime: 5 * 60_000,
  });
}

export function useMarketTrades(marketRef: string, limit = 30) {
  return useQuery({
    queryKey: [...queryKeys.trades(marketRef), limit],
    queryFn: ({ signal }) => endpoints.trades.byMarket(marketRef, limit, 0, signal),
    enabled: Boolean(marketRef),
    refetchInterval: LIVE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/** How many fills the tape shows before you have to scroll for more. */
export const TAPE_PAGE_SIZE = 10;

/**
 * The tape, a page at a time.
 *
 * ## Why offset paging is safe on a feed that keeps growing
 *
 * Offset pagination over a list with new rows arriving at the top normally drifts: three fills
 * land, every row shifts down three, and the next page re-serves rows the reader has already seen.
 *
 * That drift only ever *duplicates* here, never skips, because a tape is append-only — fills are
 * never deleted or reordered once written. Duplicates are already handled: the tape keys every row
 * by `txHash`+`outcomeIndex` and drops repeats, which it has to do anyway to reconcile pushed rows
 * against fetched ones. So the failure mode of the simple approach is a page that occasionally
 * returns nine new rows instead of ten, which nobody can see.
 *
 * ## Why polling stops once you scroll
 *
 * `refetchInterval` on an infinite query refetches **every loaded page**, so a reader five pages
 * deep would issue five requests a tick to learn about one new fill at the top. Live rows arrive
 * over the socket and are prepended by `useMarketChannel` regardless, so the poll is only a floor
 * for a dead socket — and that floor is worth having on the first page, where "latest" is the whole
 * point, and not worth having on page five, which is history and cannot change.
 */
export function useMarketTradesPages(marketRef: string, pageSize = TAPE_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.trades(marketRef), 'pages', pageSize],
    queryFn: ({ pageParam, signal }) =>
      endpoints.trades.byMarket(marketRef, pageSize, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const seen = last.offset + last.items.length;
      // A short page is the end of the list whatever `total` claims, and `total` moving under us
      // is exactly what a live feed does.
      if (last.items.length < pageSize || seen >= last.total) return undefined;
      return seen;
    },
    enabled: Boolean(marketRef),
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 1) > 1 ? false : LIVE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/**
 * Recent price shape for a whole board, keyed by market.
 *
 * One request for the page rather than one per card. The key is the sorted id list, so paging or
 * filtering fetches once and returning to a previous page is a cache hit.
 *
 * Polled far more slowly than the prices themselves: a card-sized line does not visibly change
 * from one bucket to the next, and the point of batching is undone by refetching it every four
 * seconds. The live figure on the card comes from {@link useMarkets}.
 */
export function useSparklines(marketRefs: string[], hours = 24) {
  const key = [...marketRefs].sort().join(',');
  return useQuery({
    queryKey: ['sparklines', key, hours],
    queryFn: ({ signal }) => endpoints.prices.sparklines(marketRefs, { hours }, signal),
    enabled: marketRefs.length > 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    select: (rows) => new Map(rows.map((r) => [r.marketRef, r.points])),
  });
}
