import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tickClass, usePriceTick } from './usePriceTick';

const HALF = '500000000000000000'; // 0.5 WAD

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePriceTick', () => {
  it('says nothing about the first value it sees (negative)', () => {
    // Flashing on mount would make every navigation look like the whole book had just repriced.
    const { result } = renderHook(() => usePriceTick(HALF));
    expect(result.current).toBeNull();
  });

  it('reports the direction of a move (positive)', () => {
    const { result, rerender } = renderHook(({ v }) => usePriceTick(v), {
      initialProps: { v: HALF },
    });

    rerender({ v: '600000000000000000' });
    expect(result.current).toBe('up');

    rerender({ v: '400000000000000000' });
    expect(result.current).toBe('down');
  });

  it('clears itself so a quiet book does not stay lit (positive)', () => {
    const { result, rerender } = renderHook(({ v }) => usePriceTick(v), {
      initialProps: { v: HALF },
    });
    rerender({ v: '600000000000000000' });
    expect(result.current).toBe('up');

    act(() => void vi.advanceTimersByTime(800));
    expect(result.current).toBeNull();
  });

  it('ignores a re-render that did not change the price (negative)', () => {
    const { result, rerender } = renderHook(({ v }) => usePriceTick(v), {
      initialProps: { v: HALF },
    });
    rerender({ v: HALF });
    expect(result.current).toBeNull();
  });

  it('distinguishes prices that differ beyond float precision (REGRESSION)', () => {
    // WAD is 1e18, two orders past the safe integer range. Compared as Number these two collapse
    // to the same value and the tick is silently dropped.
    const a = '500000000000000001';
    const b = '500000000000000002';
    expect(Number(a) === Number(b)).toBe(true);

    const { result, rerender } = renderHook(({ v }) => usePriceTick(v), {
      initialProps: { v: a },
    });
    rerender({ v: b });
    expect(result.current).toBe('up');
  });

  it('survives a value that is not a number (negative)', () => {
    const { result, rerender } = renderHook(({ v }) => usePriceTick(v), {
      initialProps: { v: HALF as string | null },
    });
    rerender({ v: 'not-a-price' });
    expect(result.current).toBeNull();
  });
});

describe('tickClass', () => {
  it('maps to the classes the stylesheet already animates', () => {
    // These are the same two the tape uses, and the same two reduced-motion disables.
    expect(tickClass('up')).toBe('flash-up');
    expect(tickClass('down')).toBe('flash-down');
    expect(tickClass(null)).toBeUndefined();
  });
});
