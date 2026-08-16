'use client';

import * as React from 'react';
import type { Market } from '@/lib/api/types';
import { usePool } from '@/lib/pool/PoolProvider';
import { useExecution, executionUnavailableReason } from '@/lib/execution/useExecution';
import { useRelayStatus } from '@/lib/relay/useRelayStatus';
import { closePosition, openPosition } from '@/lib/execution/trading';
import { ExecutionError } from '@/lib/execution/market-account';

/**
 * The one seam between "place a bet" in the UI and how it actually happens.
 *
 * Every path builds a signed request that our relayer submits, so the market account trades without
 * ever holding native gas — which is what keeps it unlinkable to the person behind it. There is no
 * simulated branch: a fake fill returns a hash indistinguishable from a real one, and nothing
 * downstream could tell the difference.
 */

export type SubmitTradeResult =
  | {
      ok: true;
      txHash: string;
      account: string;
      /**
       * Where the unspent remainder ended up.
       *
       * Always `pending`, by design: change from a fill stays in the market account as the trader's
       * float, because sweeping it back would make the next trade pay for another pool crossing.
       * The funding panel shows that balance and offers to return it.
       */
      change: 'swept' | 'pending';
    }
  | {
      ok: false;
      /**
       * `pending` means submitted-but-undecided; every other value is terminal.
       *
       * `unavailable` is terminal *and* not the user's fault — the relay refused before anything
       * was broadcast, so retrying this instant fails the same way.
       */
      reason: 'no-position' | 'unfilled' | 'locked' | 'failed' | 'pending' | 'unavailable';
      message?: string;
    };

export interface SubmitTradeParams {
  market: Market;
  outcomeIndex: number;
  /**
   * `short` is `buyComplement`: one share of every OTHER outcome, which pays 1 per share exactly
   * when `outcomeIndex` loses. A basket of longs rather than a separate primitive, so it inherits
   * the engine's solvency guarantee unchanged.
   */
  side: 'buy' | 'sell' | 'short';
  /** Shares to buy, short or sell, already in base units. */
  size: bigint;
  /**
   * The NO side of the outcome.
   *
   * On a buy this becomes `buyComplement`. On a sell it becomes `sellComplement`, which closes
   * every leg of the basket in one atomic call — separate calls would each be their own relayed
   * transaction, and a revert partway through would leave the trader unhedged.
   */
  complement?: boolean;
  /**
   * Draw this much into the market account rather than only what the trade needs.
   *
   * Crossing the shielded pool is the expensive leg by a wide margin, so funding once and trading
   * many times from the balance is the largest saving available — and a round figure is harder to
   * correlate with a specific fill than the exact cost of one.
   */
  funding?: bigint;
  /**
   * Slippage guard, base units: max cost on a buy, min refund on a sell.
   *
   * Both are **fee-inclusive**, because the engine's quotes are: `quoteBuy` returns what the trader
   * pays and `quoteSell` what they receive. A guard derived from a fee-exclusive figure would
   * revert every trade by exactly the fee.
   */
  guard: bigint;
  /** Progress, so a wait of tens of seconds reads as work rather than a hang. */
  onStatus?: (status: string) => void;
}

export interface SubmitTrade {
  submit: (params: SubmitTradeParams) => Promise<SubmitTradeResult>;
  /** Available, but the user has not unlocked this session — offer the passkey. */
  needsUnlock: boolean;
  /**
   * No private trading on this deployment at all. Distinct from `needsUnlock`: inviting someone to
   * unlock into something that cannot execute a trade wastes a passkey prompt and reads as a bug.
   */
  unavailable: boolean;
  /**
   * Sponsored gas is off right now, so no bet can be placed by anybody.
   *
   * Separate from {@link unavailable}, which is a fact about the deployment. This one is usually
   * temporary and always ours rather than the trader's, so it earns its own copy: `capped` is
   * today's gas budget spent and resumes tomorrow, `disabled` is a deployment with no relayer.
   *
   * Asked before the press. Without it the first thing a trader learns about a paused relayer is
   * a failure after they have signed and waited.
   */
  paused: 'disabled' | 'capped' | null;
  unlock: () => Promise<void>;
}

export function useSubmitTrade(market?: Market): SubmitTrade {
  const { status, unlock } = usePool();
  const relay = useRelayStatus();
  const execution = useExecution({
    marketRef: market?.id ?? '',
    engine: market?.address ?? '',
    token: market?.collateral ?? '',
  });

  const submit = React.useCallback(
    async (params: SubmitTradeParams): Promise<SubmitTradeResult> => {
      const { market: m, outcomeIndex, side, size, guard, onStatus } = params;

      if (!execution) {
        // Not an error — the user simply has not unlocked this session yet.
        return { ok: false, reason: 'locked' };
      }
      // The hook is built from whichever market was passed at render; a mismatch would sign a
      // request against one market's account for another market's trade.
      const ctx = { ...execution, marketRef: m.id, engine: m.address as `0x${string}`, token: m.collateral };

      const common = { marketId: BigInt(m.marketId), outcomeId: BigInt(outcomeIndex) };

      try {
        const result =
          side === 'sell'
            ? await closePosition(ctx, {
                ...common,
                sharesIn: size,
                minRefund: guard,
                complement: params.complement,
                onStatus,
              })
            : await openPosition(ctx, {
                ...common,
                sharesOut: size,
                maxCost: guard,
                complement: side === 'short',
                funding: params.funding,
                onStatus,
              });

        return { ok: true, txHash: result.hash, account: result.account, change: 'pending' };
      } catch (err) {
        if (err instanceof ExecutionError) {
          // Map by code, not by type. Reporting every failure the same way is how a trade that
          // merely timed out — and may still land — tells the user it did not happen.
          const reason =
            err.code === 'pending'
              ? 'pending'
              : err.code === 'pool'
                ? 'unavailable'
                : 'failed';
          return { ok: false, reason, message: err.message };
        }
        return {
          ok: false,
          reason: 'failed',
          message: err instanceof Error ? err.message : 'The bet could not be submitted.',
        };
      }
    },
    [execution],
  );

  return {
    submit,
    needsUnlock: status === 'locked' || status === 'error',
    unavailable: status === 'unavailable' || executionUnavailableReason() !== null,
    paused: relay.available ? null : relay.reason,
    unlock,
  };
}
