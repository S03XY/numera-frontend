'use client';

import * as React from 'react';
import type { Position } from '@/lib/api/types';
import { usePool } from '@/lib/pool/PoolProvider';
import { useExecution, executionUnavailableReason } from '@/lib/execution/useExecution';
import { claimWinnings } from '@/lib/execution/trading';
import { ExecutionError } from '@/lib/execution/market-account';

/**
 * Collecting a settled position — the mirror of `useSubmitTrade`.
 *
 * The claim runs from the same market account that opened the position, because that account is
 * the `_msgSender()` the contract credited. That account is **derived**, not looked up: there is no
 * local map to lose and no "restore your positions" step, which is why `unknown-account` no longer
 * appears among the failure reasons here. A user on a new device signs in with their passkey and
 * every account they have ever held comes back.
 *
 * Winning shares pay 1:1 and settlement takes no fee — the trade was charged on the way in — and
 * there is no deadline on the engine's claim path, so a late claim is always still payable.
 */

export type ClaimResult =
  | { ok: true; txHash: string }
  | {
      ok: false;
      /**
       * `unavailable` is the relay or the pool being down — nothing about this claim, and the
       * winnings are still there.
       * `pending` is submitted-and-undecided. Never say "nothing happened" for it.
       */
      reason: 'locked' | 'failed' | 'unavailable' | 'pending';
      message?: string;
    };

export interface ClaimPosition {
  claim: (position: Position) => Promise<ClaimResult>;
  /** Available, but this session has not unlocked the shielded key yet. */
  needsUnlock: boolean;
  unavailable: boolean;
  unlock: () => Promise<void>;
}

export function useClaimPosition(): ClaimPosition {
  const { status, unlock } = usePool();
  // Bound per call rather than per render: the position carries its own market, and each market
  // has its own derived account.
  const execution = useExecution({ marketRef: '', engine: '', token: '' });

  const claim = React.useCallback(
    async (position: Position): Promise<ClaimResult> => {
      if (!execution) return { ok: false, reason: 'locked' };

      try {
        const result = await claimWinnings(
          {
            ...execution,
            marketRef: position.marketRef,
            engine: position.marketAddress as `0x${string}`,
            token: position.collateral,
          },
          { marketId: BigInt(position.marketOnChainId) },
        );
        return { ok: true, txHash: result.hash };
      } catch (err) {
        if (err instanceof ExecutionError) {
          // An outage has nothing to do with this position — the winnings are still there and
          // still claimable once it is back. Reporting it as a failed claim sends the user
          // looking for a problem with their position.
          const reason =
            err.code === 'pending' ? 'pending' : err.code === 'pool' ? 'unavailable' : 'failed';
          return { ok: false, reason, message: err.message };
        }
        return {
          ok: false,
          reason: 'failed',
          message: err instanceof Error ? err.message : 'The claim could not be submitted.',
        };
      }
    },
    [execution],
  );

  return {
    claim,
    needsUnlock: status === 'locked' || status === 'error',
    unavailable: status === 'unavailable' || executionUnavailableReason() !== null,
    unlock,
  };
}
