'use client';

import * as React from 'react';
import { toBigInt } from '@/lib/format';

/**
 * Which way a number just moved, for the moment after it moves.
 *
 * A price that changes silently reads as a static page. The data is already arriving live — the
 * market channel pushes every trade — but nothing on screen acknowledged the change, so the book
 * looked frozen between navigations. One brief flash is the cheapest possible "this is live", and
 * it costs no layout: it reuses `.flash-up` / `.flash-down`, which the tape already uses and
 * which reduced-motion already disables.
 *
 * Compared as bigint, not as float. Prices are WAD (1e18), which is two orders of magnitude past
 * the safe integer range — `Number()` would collapse genuinely different prices onto the same
 * value and silently drop ticks.
 */
export type Tick = 'up' | 'down' | null;

/** Long enough to notice, short enough that a fast tape does not strobe. */
const HOLD_MS = 700;

export function usePriceTick(value: string | bigint | null | undefined): Tick {
  const key = value === null || value === undefined ? null : value.toString();
  const previous = React.useRef<string | null>(null);
  const [tick, setTick] = React.useState<Tick>(null);

  React.useEffect(() => {
    if (key === null) return;
    const before = previous.current;
    previous.current = key;
    // The first observed value is not a move. Flashing on mount would make every navigation look
    // like the whole book had just repriced.
    if (before === null || before === key) return;

    const a = toBigInt(before);
    const b = toBigInt(key);
    if (a === null || b === null || a === b) return;

    setTick(b > a ? 'up' : 'down');
    const id = setTimeout(() => setTick(null), HOLD_MS);
    return () => clearTimeout(id);
  }, [key]);

  return tick;
}

/** The class for a tick, or `undefined` when nothing moved. */
export function tickClass(tick: Tick): string | undefined {
  return tick === 'up' ? 'flash-up' : tick === 'down' ? 'flash-down' : undefined;
}
