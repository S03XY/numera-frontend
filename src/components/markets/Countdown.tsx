'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { useNow, useSecond } from '@/lib/useNow';

/**
 * Time to close, as digits that move.
 *
 * A market's deadline is the one number on the page that is always changing and was the only one
 * rendered as prose. "IN 1D 21H" is fine at a glance and useless in the last ten minutes, which is
 * exactly when a trader is deciding whether they still have time to place a bet. So it ticks, in
 * tabular figures, and the seconds are there because the seconds are the point.
 *
 * ## Which clock, and why it matters
 *
 * There are two shared tickers, at 30s and 1s (see `lib/useNow`), and the board is the reason. A
 * market page holds one countdown and can have every second. The board can hold sixty, and putting
 * all of them on the fast clock means sixty components re-rendering once a second, forever, for
 * information that does not change: a market closing in four days does not need its seconds drawn.
 *
 * So the fast clock is subscribed to by a *child* that only mounts once the deadline is close.
 * Hooks cannot be called conditionally, but components can be rendered conditionally, and the
 * parent decides on the slow clock which one to draw. The result is that a distant market costs a
 * re-render every thirty seconds and an imminent one costs a re-render every second, which is the
 * arrangement both of them want.
 */

/** Zero padded, because a clock that jumps between one and two digits is a clock that jitters. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * `2d 04:31:12`, `04:31:12`, or `31:12`.
 *
 * Days are dropped once there are none, and hours once there are none, so the display gets shorter
 * as the deadline approaches rather than showing a row of leading zeroes that mean nothing.
 */
export function formatCountdown(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));

  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Under this, every second is worth drawing and the figure turns urgent. */
export const URGENT_MS = 60 * 60 * 1000;

export interface CountdownProps {
  /** ISO close time. */
  target: string;
  className?: string;
  /**
   * Draw seconds however far away the deadline is.
   *
   * For the market page, which holds exactly one of these. Leave it off on the board.
   */
  alwaysTicking?: boolean;
}

/**
 * The digits, on the fast clock. Only ever mounted when the seconds are worth paying for.
 *
 * `aria-hidden` on the digits with a live region alongside would announce a new time every second,
 * which is unusable. The whole element carries one static label instead and the digits are left to
 * the eye.
 */
function Ticking({
  target,
  className,
  urgent,
}: {
  target: string;
  className?: string;
  urgent?: boolean;
}) {
  const now = useSecond();
  const remaining = now === null ? null : new Date(target).getTime() - now;

  return (
    <span
      className={cn(
        'tabular mono text-[10.5px] tracking-[0.14em] uppercase',
        className,
        // Last, so it beats whatever colour the caller passed. Urgency outranks house styling:
        // putting this before `className` let a caller's `text-ink-mute` win the merge and silently
        // drained the accent out of the final hour, which is the one hour it exists for.
        urgent && 'text-accent-bright',
      )}
      aria-label="Time until trading closes"
    >
      {/* No clock before hydration: the server has none, and a countdown drawn from one it
          invented would be wrong on the first paint and then visibly jump. */}
      {remaining === null ? ' ' : remaining <= 0 ? 'Closed' : formatCountdown(remaining)}
    </span>
  );
}

/**
 * The market page's clock: a labelled block, at a size you can read across a desk.
 *
 * The same countdown exists in the breadcrumb of every card, at 10.5px, and on the one page built
 * around a single market that is the wrong weight for it. A deadline you are trading against is
 * not metadata. This states what it is, then the digits, big enough that the seconds are the point
 * rather than a detail you have to go looking for.
 *
 * It stops rather than counting up. Once the book is shut, how long ago that happened is a fact
 * about the past and the resolution panel below is the thing that matters.
 */
export function CloseClock({ target, closed }: { target: string; closed: boolean }) {
  // Its own clock and its own markup rather than a restyled {@link Countdown}. That version baked
  // `text-[10.5px]` into the element it rendered, so the block's size had to be forced back out
  // through the class list and lost the merge: the "big" clock came out at breadcrumb size. Two
  // presentations of one calculation is the honest shape — `formatCountdown` is the shared part.
  const now = useSecond();
  const remaining = now === null ? null : new Date(target).getTime() - now;
  const over = closed || (remaining !== null && remaining <= 0);
  const urgent = !over && remaining !== null && remaining < URGENT_MS;

  return (
    <div className="shrink-0 sm:text-right">
      <p className="folio">{over ? 'Trading closed' : 'Closes in'}</p>
      <p
        className={cn(
          // No `uppercase` here, unlike the small one: at this size "3D" reads as a unit rather
          // than as days, and the row is not a run of small caps that it has to match.
          'tabular mono mt-1.5 text-[22px] leading-none sm:text-[26px]',
          over ? 'text-ink-mute' : urgent ? 'text-accent-bright' : 'text-ink',
        )}
        aria-label={over ? 'Trading has closed' : 'Time until trading closes'}
      >
        {/* No clock before hydration: a dash rather than an invented time, at the same width. */}
        {over ? '00:00' : remaining === null ? '--:--' : formatCountdown(remaining)}
      </p>
    </div>
  );
}

export function Countdown({ target, className, alwaysTicking = false }: CountdownProps) {
  const now = useNow();
  const parsed = new Date(target).getTime();
  if (Number.isNaN(parsed)) return null;

  const remaining = now === null ? null : parsed - now;

  // Hold the row's height before hydration rather than collapsing it, so nothing reflows when the
  // clock arrives a frame later.
  if (remaining === null) {
    return <span className={cn('mono text-[10.5px]', className)} aria-hidden="true">&nbsp;</span>;
  }

  if (remaining <= 0) {
    return (
      <span className={cn('mono text-[10.5px] tracking-[0.14em] uppercase', className)}>Closed</span>
    );
  }

  if (alwaysTicking || remaining < URGENT_MS) {
    return <Ticking target={target} className={className} urgent={remaining < URGENT_MS} />;
  }

  // Far out, on the slow clock: days and hours, no seconds to churn over.
  return (
    <span
      className={cn('tabular mono text-[10.5px] tracking-[0.14em] uppercase', className)}
      aria-label="Time until trading closes"
    >
      {formatCountdown(remaining)}
    </span>
  );
}
