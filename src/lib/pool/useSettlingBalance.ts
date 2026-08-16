'use client';

import * as React from 'react';

/**
 * Waiting for a balance to catch up with something we just did to it.
 *
 * ## The bug this exists to stop
 *
 * A deposit completes, the success toast appears, and the balance does not move. It corrects
 * itself only when the user reconnects — at which point their money was there all along. Reported
 * as "the deposit didn't update", and it looks for all the world like a broken refetch.
 *
 * The refetch is fine. It fires exactly *once*, and Engine's index is eventually consistent:
 * `deposit().wait()` resolves when the deposit is usable, which is not the same instant
 * `getBalances` starts counting it. One invalidation is a single sample of a source that is still
 * settling, and a single sample of an eventually-consistent value is a coin toss.
 *
 * The polling that exists for exactly this was gated on Engine's `syncing` flag — but `syncing`
 * answers a different question. It means "am I catching up in general", not "does this figure
 * include the thing you just did". Engine can honestly answer `false` while still serving a total
 * that predates the transfer, and the moment it does, polling stops and the stale number stays on
 * screen with nothing scheduled to correct it.
 *
 * ## What this asserts instead
 *
 * The one thing we actually know: **this exact figure is out of date, because we just moved
 * money.** So poll until it stops being that figure, rather than until a vendor flag says
 * something adjacent. No guess at the expected value is needed — any change means the index has
 * caught up, which works for a deposit, a withdrawal, and a sweep alike.
 *
 * Bounded by {@link SETTLE_TIMEOUT_MS}, because a transfer that never lands is a real outcome and
 * an indicator that spins forever describes it as "still working".
 */

/**
 * How long to keep asking.
 *
 * Generous: Engine's lag is measured in seconds and occasionally tens of them, and the cost is one
 * call every couple of seconds against a figure the user is actively watching.
 */
export const SETTLE_TIMEOUT_MS = 90_000;

/** How often to re-read while waiting. */
export const SETTLE_POLL_MS = 2_000;

export interface SettlingBalance {
  /**
   * A transfer has completed and this figure has not moved yet.
   *
   * Drive whatever the panel says about the wait from this — a balance quietly refusing to change
   * is the thing that reads as money going missing.
   */
  pending: boolean;
  /**
   * Start waiting. Pass the figure as it read *before* the transfer.
   *
   * Called with the pre-action value rather than reading it here, because by the time an
   * operation resolves the cache may already hold the new one — and comparing a figure with
   * itself waits forever.
   */
  expect: (was: bigint | undefined) => void;
}

/**
 * The figure being waited on, as a ref the caller declares.
 *
 * Awkward-looking, and load-bearing: this is read from a React Query `refetchInterval` closure,
 * which is defined *above* the hook call because the hook needs the query's own data. A `const`
 * declared below would be in its temporal dead zone if React Query ever evaluated that closure
 * during render rather than in an effect. A ref declared first cannot be, whatever they change.
 *
 * `null` means nothing is being waited for.
 */
export type AwaitedTotal = React.RefObject<bigint | null>;

export function useSettlingBalance(
  awaitingRef: AwaitedTotal,
  total: bigint | undefined,
): SettlingBalance {
  const [settling, setSettling] = React.useState<{ was: bigint } | null>(null);

  /*
    Derived, never cleared on arrival — which is what makes this a plain expression rather than an
    effect that has to notice the change and write state back.

    Both consumers fall out of the comparison on their own the moment the figure moves: `pending`
    goes false so the panel stops saying "updating", and `settlingInterval` stops matching so the
    poll stops. Nothing needs to observe the transition, so nothing does.
  */
  const pending = settling !== null && total !== undefined && total === settling.was;

  /*
    The deadline, and the only thing here that genuinely needs an effect: a transfer that never
    lands must stop polling rather than ask forever.

    A timer rather than a `Date.now()` comparison during render — reading the clock while
    rendering is impure, and this is the codebase that already learned that in `useNow`. The
    `setSettling` runs in the timer callback, not in the effect body, so it schedules one render
    ninety seconds later instead of cascading.
  */
  React.useEffect(() => {
    if (settling === null) return;
    const timer = setTimeout(() => {
      setSettling(null);
      awaitingRef.current = null;
    }, SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [settling, awaitingRef]);

  const expect = React.useCallback(
    (was: bigint | undefined) => {
      if (was === undefined) return;
      awaitingRef.current = was;
      setSettling({ was });
    },
    [awaitingRef],
  );

  return { pending, expect };
}

/** Whether to keep re-reading, given the figure a query currently holds. */
export function settlingInterval(
  awaitingRef: AwaitedTotal,
  total: bigint | undefined,
): number | false {
  return awaitingRef.current !== null && total === awaitingRef.current ? SETTLE_POLL_MS : false;
}
