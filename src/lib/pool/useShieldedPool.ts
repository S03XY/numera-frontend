'use client';

import * as React from 'react';
import type { ShieldedPool } from '@/lib/execution/pool';
import { numeraPool } from './client';
import { usePool } from './PoolProvider';

/**
 * The shielded pool bound to this session, or `null` while it is locked.
 *
 * `null` is a normal state and not an error: the trader simply has not unlocked yet, and callers
 * offer the passkey rather than reporting a fault.
 *
 * Memoised on the root alone. The pool object holds no connection and no session — it is a handful
 * of closures over some derived keys — so rebuilding it is cheap, but a stable identity keeps it out
 * of the dependency arrays of everything that reads a balance.
 */
export function useShieldedPool(): ShieldedPool | null {
  const { executionRoot } = usePool();

  return React.useMemo(() => {
    if (!executionRoot) return null;
    try {
      return numeraPool({ root: executionRoot });
    } catch {
      // `numeraPool` throws only when the pool is unconfigured, which the provider already reports
      // as `unavailable`. Returning null here keeps a misconfigured build from crashing the render
      // tree of every page that happens to show a balance.
      return null;
    }
  }, [executionRoot]);
}
