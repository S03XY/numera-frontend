import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTLE_POLL_MS,
  SETTLE_TIMEOUT_MS,
  settlingInterval,
  useSettlingBalance,
} from './useSettlingBalance';

/** Drives the hook the way a panel does: a ref, plus the figure a query currently holds. */
function harness(initial: bigint | undefined) {
  const ref = React.createRef<bigint | null>() as React.RefObject<bigint | null>;
  ref.current = null;
  const view = renderHook(({ total }: { total: bigint | undefined }) => useSettlingBalance(ref, total), {
    initialProps: { total: initial },
  });
  return { ref, view };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSettlingBalance', () => {
  it('waits while the figure still reads what it did before the transfer (positive)', () => {
    // The bug: a deposit completes, the toast fires, and the balance does not move — because the
    // single refetch sampled an index that had not caught up, and `syncing: false` stopped the
    // poll on the spot.
    const { ref, view } = harness(100n);

    act(() => view.result.current.expect(100n));
    expect(view.result.current.pending).toBe(true);
    expect(settlingInterval(ref, 100n)).toBe(SETTLE_POLL_MS);
  });

  it('stops the moment the figure moves (positive)', () => {
    const { ref, view } = harness(100n);
    act(() => view.result.current.expect(100n));

    view.rerender({ total: 150n });

    expect(view.result.current.pending).toBe(false);
    expect(settlingInterval(ref, 150n)).toBe(false);
  });

  it('waits on a withdrawal too, where the figure goes DOWN (positive)', () => {
    // Deliberately no expected value, only "not this one" — a deposit, a withdrawal and a sweep
    // all mean the same thing here, and guessing the arithmetic would be a second place to be
    // wrong about fees.
    const { view } = harness(100n);
    act(() => view.result.current.expect(100n));

    view.rerender({ total: 40n });
    expect(view.result.current.pending).toBe(false);
  });

  it('gives up rather than polling forever (negative)', () => {
    // A transfer that never lands is a real outcome, and an indicator that spins indefinitely
    // describes it as "still working".
    const { ref, view } = harness(100n);
    act(() => view.result.current.expect(100n));
    expect(view.result.current.pending).toBe(true);

    act(() => void vi.advanceTimersByTime(SETTLE_TIMEOUT_MS + 1));

    expect(view.result.current.pending).toBe(false);
    expect(ref.current).toBeNull();
    expect(settlingInterval(ref, 100n)).toBe(false);
  });

  it('does not wait when the pre-transfer figure was never read (negative)', () => {
    // No baseline means no comparison to make. Waiting on `undefined` would poll for ninety
    // seconds against a figure that can never satisfy it.
    const { ref, view } = harness(undefined);
    act(() => view.result.current.expect(undefined));

    expect(view.result.current.pending).toBe(false);
    expect(ref.current).toBeNull();
  });

  it('polls only for the figure it was told about (negative)', () => {
    // The ref is shared with a `refetchInterval` closure that sees every update of that query.
    const { ref, view } = harness(100n);
    act(() => view.result.current.expect(100n));

    expect(settlingInterval(ref, 999n)).toBe(false);
  });
});
