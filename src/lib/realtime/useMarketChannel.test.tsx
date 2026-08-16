import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMarketChannel } from './useMarketChannel';
import { __setSocket } from './socket';
import { queryKeys } from '@/lib/hooks/useMarkets';
import { makeMarket } from '@/test/render';

const MARKET_REF = '11111111-1111-4111-8111-111111111111';

/** Minimal Socket.IO double with a real listener registry. */
function createFakeSocket(connected = true) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const emitted: { event: string; payload: unknown }[] = [];

  return {
    connected,
    emitted,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return this;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(fn);
      return this;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return this;
    },
    /** Simulate a server-pushed event. */
    server(event: string, payload: unknown) {
      handlers.get(event)?.forEach((fn) => fn(payload));
    },
    listenerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

type FakeSocket = ReturnType<typeof createFakeSocket>;

// `null` means "render with no market ref" — an explicit `undefined` argument
// would still trigger the default parameter, which is not what we want to test.
function setup(socket: FakeSocket, marketRef: string | null = MARKET_REF) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setSocket(socket as any);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.market(MARKET_REF), makeMarket({ id: MARKET_REF }));

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useMarketChannel(marketRef ?? undefined), { wrapper });
  return { ...view, client };
}

beforeEach(() => __setSocket(null));

describe('useMarketChannel', () => {
  it('subscribes to the market room on mount when already connected (positive)', async () => {
    const socket = createFakeSocket(true);
    const { result } = setup(socket);

    // Subscribing is synchronous — the room must be joined before any event can
    // be missed. Flagging the UI as connected is deferred by a microtask so the
    // mount does not cascade an extra render.
    expect(socket.emitted).toContainEqual({ event: 'subscribe', payload: { marketRef: MARKET_REF } });
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('re-subscribes after a reconnect (critical — rooms are per-connection)', () => {
    const socket = createFakeSocket(false);
    setup(socket);
    expect(socket.emitted.filter((e) => e.event === 'subscribe')).toHaveLength(0);

    act(() => socket.server('connect', undefined));
    expect(socket.emitted.filter((e) => e.event === 'subscribe')).toHaveLength(1);

    // A drop and reconnect must issue a fresh subscribe, or the UI silently goes stale.
    act(() => socket.server('disconnect', undefined));
    act(() => socket.server('connect', undefined));
    expect(socket.emitted.filter((e) => e.event === 'subscribe')).toHaveLength(2);
  });

  it('refetches the snapshot on reconnect to cover the missed gap (regression)', async () => {
    const socket = createFakeSocket(false);
    const { client } = setup(socket);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    act(() => socket.server('connect', undefined));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.market(MARKET_REF) }),
    );
  });

  it('tracks connection state for the UI', () => {
    const socket = createFakeSocket(false);
    const { result } = setup(socket);
    expect(result.current.connected).toBe(false);

    act(() => socket.server('connect', undefined));
    expect(result.current.connected).toBe(true);

    act(() => socket.server('disconnect', undefined));
    expect(result.current.connected).toBe(false);
  });

  it('folds a price push into the cached market (positive)', () => {
    const socket = createFakeSocket(true);
    const { client } = setup(socket);

    act(() =>
      socket.server('price', {
        event: 'price',
        data: { prices: ['700000000000000000', '300000000000000000'] },
        ts: Date.now(),
      }),
    );

    const market = client.getQueryData(queryKeys.market(MARKET_REF)) as ReturnType<typeof makeMarket>;
    expect(market.outcomes[0].priceWad).toBe('700000000000000000');
    expect(market.outcomes[1].priceWad).toBe('300000000000000000');
  });

  it('ignores a malformed price payload rather than corrupting the cache (negative)', () => {
    const socket = createFakeSocket(true);
    const { client } = setup(socket);
    const before = client.getQueryData(queryKeys.market(MARKET_REF));

    act(() => socket.server('price', { event: 'price', data: { prices: null }, ts: 1 }));
    act(() => socket.server('price', { event: 'price', data: {}, ts: 1 }));

    expect(client.getQueryData(queryKeys.market(MARKET_REF))).toEqual(before);
  });

  it('accumulates live trades newest-first and dedupes replays (regression)', () => {
    const socket = createFakeSocket(true);
    const { result } = setup(socket);
    const trade = (txHash: string) => ({
      event: 'trade',
      data: {
        side: 'BUY',
        account: '0xabc',
        outcomeIndex: 0,
        amount: '100',
        priceWad: '500000000000000000',
        txHash,
        timestamp: new Date().toISOString(),
      },
      ts: Date.now(),
    });

    act(() => socket.server('trade', trade('0x1')));
    act(() => socket.server('trade', trade('0x2')));
    act(() => socket.server('trade', trade('0x1'))); // duplicate replay

    expect(result.current.liveTrades).toHaveLength(2);
    expect(result.current.liveTrades[0].txHash).toBe('0x2'); // newest first
  });

  it.each([
    [
      'trade',
      {
        event: 'trade',
        data: {
          side: 'BUY',
          account: '0xabc',
          outcomeIndex: 0,
          amount: '100',
          priceWad: '500000000000000000',
          txHash: '0xrequote',
          timestamp: new Date().toISOString(),
        },
        ts: Date.now(),
      },
    ],
    ['price', { event: 'price', data: { prices: ['600000000000000000'] }, ts: Date.now() }],
  ])('re-reads the open ticket\'s quote when a %s moves the book (positive)', (event, payload) => {
    // The push half of quote freshness, and the half that does the real work. A fill changes the
    // curve, the server knows the instant it happens, and the alternative is waiting out a timer
    // to discover something we were already told. Invalidation rather than a cache write, because
    // a quote is a pure function of the chain and the socket does not carry it.
    const socket = createFakeSocket(true);
    const { client } = setup(socket);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    act(() => socket.server(event, payload));

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['contract-quote']));
    expect(keys).toContain(JSON.stringify(['shares-for-budget']));
  });

  it('applies a resolution status push', () => {
    const socket = createFakeSocket(true);
    const { client } = setup(socket);

    act(() =>
      socket.server('market_status', {
        event: 'market_status',
        data: { status: 'RESOLVED', winningOutcomeId: 1 },
        ts: Date.now(),
      }),
    );

    const market = client.getQueryData(queryKeys.market(MARKET_REF)) as ReturnType<typeof makeMarket>;
    expect(market.status).toBe('RESOLVED');
    expect(market.winningOutcomeId).toBe(1);
    expect(market.tradingOpen).toBe(false);
  });

  it('unsubscribes and removes every listener on unmount (regression — leak)', () => {
    const socket = createFakeSocket(true);
    const { unmount } = setup(socket);
    expect(socket.listenerCount('price')).toBe(1);

    unmount();

    expect(socket.emitted).toContainEqual({
      event: 'unsubscribe',
      payload: { marketRef: MARKET_REF },
    });
    for (const event of ['connect', 'disconnect', 'price', 'trade', 'market_status', 'resolution']) {
      expect(socket.listenerCount(event)).toBe(0);
    }
  });

  it('does nothing without a market ref (negative)', () => {
    const socket = createFakeSocket(true);
    setup(socket, null);
    expect(socket.emitted).toHaveLength(0);
  });
});
