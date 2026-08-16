'use client';

import * as React from 'react';

/**
 * The current time, as a render-safe external store.
 *
 * Calling `Date.now()` during render is impure: the server and the client
 * disagree, and a countdown rendered that way freezes at whatever the first
 * paint happened to see. One shared ticker drives every countdown on the page
 * instead, so they stay live and stay in step with each other.
 *
 * Returns `null` on the server and before hydration — callers render a
 * time-independent state until a real clock is available.
 *
 * ## Two rates, one implementation
 *
 * Market countdowns ("closes in 1d 6h") are wrong by at most a minute and cost a re-render of
 * every card on the board, so they tick every thirty seconds. A quote's refresh countdown has to
 * move every second to be worth showing at all. Sharing the slow ticker would make it stutter in
 * thirty-second jumps; giving each caller its own `setInterval` would put a timer on every card.
 * A clock per rate, shared by every caller at that rate, is the only arrangement that is neither.
 */

function createClock(intervalMs: number) {
  let now = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    if (!timer) {
      now = Date.now();
      timer = setInterval(() => {
        now = Date.now();
        for (const listener of listeners) listener();
      }, intervalMs);
    }
    return () => {
      listeners.delete(onChange);
      // The timer only exists while something is watching it, so an idle page has none.
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  // Must return a cached value, never a fresh Date.now(): a changing snapshot on
  // every call makes useSyncExternalStore re-render forever.
  function getSnapshot(): number {
    if (now === 0) now = Date.now();
    return now;
  }

  const getServerSnapshot = (): number => 0;

  return function useClock(): number | null {
    const value = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    return value === 0 ? null : value;
  };
}

/** Wall clock at 30s resolution — close-time countdowns, "closed 12m ago". */
export const useNow = createClock(30_000);

/** Wall clock at 1s resolution. For a countdown a person is watching tick. */
export const useSecond = createClock(1_000);
