'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { formatUsd } from '@/lib/format';
import { tickClass, usePriceTick } from '@/lib/usePriceTick';
import { Bar, useDelayedFlag } from './Waiting';

/**
 * A money figure that behaves like one on an exchange.
 *
 * Three things separate a live balance from a number printed on a page, and this has all three:
 *
 *  - **It acknowledges its own movement.** A balance that changes silently reads as a static
 *    page even when it is being polled every few seconds. One brief flash — green up, red down —
 *    is the cheapest possible proof that the figure is current, and it reuses the same
 *    `.flash-up` / `.flash-down` rules the tape and the price ticks already use, so the whole
 *    interface agrees on what "just moved" looks like.
 *  - **It holds its place rather than blanking.** While the figure is unknown it renders a bar
 *    at the width the number will occupy, not a dash. Nothing beside it moves when the figure
 *    lands, which on a panel of five balances is the difference between a read and a reflow.
 *  - **It never lies about not knowing.** `unknown` renders as its own state, distinct from
 *    zero. An RPC that failed to answer and an empty account are different facts and a trader
 *    acts differently on each, so they must never render the same.
 *
 * Held back by {@link useDelayedFlag}, so a read that resolves in twenty milliseconds does not
 * flash a placeholder for one frame on its way past.
 */
export interface LiveBalanceProps {
  /** Base units, or `null` when the figure is not known yet. */
  value: bigint | null;
  decimals: number;
  /** Still loading — hold the space rather than showing a figure. */
  pending?: boolean;
  /** Known to be unreadable. Renders `label` instead of pretending it is zero. */
  unknown?: boolean;
  /** What to show in place of a figure that will never arrive (e.g. "Not set up"). */
  placeholder?: React.ReactNode;
  /** Width of the loading state in characters. Roughly the width of the figure it replaces. */
  chars?: number;
  className?: string;
  /** Trailing note — "syncing", a delta, a unit. */
  suffix?: React.ReactNode;
}

export function LiveBalance({
  value,
  decimals,
  pending = false,
  unknown = false,
  placeholder = '—',
  chars = 7,
  className,
  suffix,
}: LiveBalanceProps) {
  const tick = usePriceTick(value);
  const showLoading = useDelayedFlag(pending);

  if (pending) {
    return (
      <span className={cn('tabular', className)} role="status" aria-label="Reading balance">
        {showLoading ? <Bar chars={chars} /> : <span>&nbsp;</span>}
      </span>
    );
  }

  if (unknown || value === null) {
    return <span className={cn('tabular text-ink-mute', className)}>{placeholder}</span>;
  }

  return (
    <span className={cn('tabular -mx-1 px-1', className, tickClass(tick))}>
      {formatUsd(value, decimals)}
      {suffix}
    </span>
  );
}
