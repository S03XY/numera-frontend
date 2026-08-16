'use client';

import * as React from 'react';
import type { Market } from '@/lib/api/types';
import { usePool } from '@/lib/pool/PoolProvider';
import { useExecution, executionUnavailableReason } from '@/lib/execution/useExecution';
import { shieldBalance, TRADE_STATUS } from '@/lib/execution/trading';
import { addressFor, fundMarket, ExecutionError } from '@/lib/execution/market-account';

/**
 * Moving collateral between the shielded pool and one market's account.
 *
 * The sibling of `useSubmitTrade`, and deliberately separate from it. A trade and a transfer fail
 * for different reasons, take different amounts of time, and need different things said about
 * them — folding the transfer into the trade is what produced "your bet was not placed" for an
 * operation that never got as far as offering a bet.
 *
 * Both directions are now a single pool operation rather than a multi-step session. That removes
 * `busy` from the failure set entirely: there is no per-account lock to wait on, because there is
 * no session to hold one. It also makes "nothing was moved" a promise this can keep — a failed
 * withdrawal releases its notes rather than stranding them at `accepted`.
 */

export type FundingResult =
  | { ok: true; txHash: string; account: string }
  | {
      ok: false;
      /**
       * `locked` — the session has no shielded key yet; offer the passkey.
       * `unavailable` — the pool refused before anything moved. Nothing was spent, and an
       *   immediate retry fails identically, so the copy must say "later", not "again".
       * `pending` — submitted and undecided. NOT a failure; never say "nothing was moved".
       */
      reason: 'locked' | 'unavailable' | 'pending' | 'failed';
      message?: string;
    };

export interface MarketFunding {
  /** Shielded pool → this market's account. */
  deposit: (params: {
    market: Market;
    amount: bigint;
    onStatus?: (status: string) => void;
  }) => Promise<FundingResult>;
  /** This market's account → the shielded pool. Returns the whole balance. */
  withdraw: (params: {
    market: Market;
    balance: bigint;
    onStatus?: (status: string) => void;
  }) => Promise<FundingResult>;
  needsUnlock: boolean;
  unavailable: boolean;
  unlock: () => Promise<void>;
}

export function useMarketFunding(): MarketFunding {
  const { status, unlock } = usePool();
  const execution = useExecution({ marketRef: '', engine: '', token: '' });

  const run = React.useCallback(
    async (
      market: Market,
      action: (ctx: NonNullable<typeof execution>) => Promise<{ account: string }>,
    ): Promise<FundingResult> => {
      if (!execution) return { ok: false, reason: 'locked' };
      const ctx = {
        ...execution,
        marketRef: market.id,
        engine: market.address as `0x${string}`,
        token: market.collateral,
      };

      try {
        const result = await action(ctx);
        // A pool transfer is relayed by the pool's own infrastructure and reports no hash of its
        // own. The balance is the confirmation, which is what the funding panel reads.
        return { ok: true, txHash: '', account: result.account };
      } catch (err) {
        if (err instanceof ExecutionError) {
          const reason =
            err.code === 'pending' ? 'pending' : err.code === 'pool' ? 'unavailable' : 'failed';
          return { ok: false, reason, message: err.message };
        }
        return {
          ok: false,
          reason: 'failed',
          message: err instanceof Error ? err.message : 'The transfer could not be submitted.',
        };
      }
    },
    [execution],
  );

  const deposit = React.useCallback<MarketFunding['deposit']>(
    ({ market, amount, onStatus }) =>
      run(market, async (ctx) => {
        onStatus?.(TRADE_STATUS.funding);
        return fundMarket(ctx, { amount });
      }),
    [run],
  );

  const withdraw = React.useCallback<MarketFunding['withdraw']>(
    ({ market, onStatus }) =>
      run(market, async (ctx) => {
        const account = addressFor(ctx);
        // The balance is re-read here rather than taken from the caller: a trade settling in
        // between would otherwise leave the difference behind as dust in an account the trader has
        // just been told is empty.
        await shieldBalance(ctx, account, onStatus);
        return { account };
      }),
    [run],
  );

  return {
    deposit,
    withdraw,
    needsUnlock: status === 'locked' || status === 'error',
    unavailable: status === 'unavailable' || executionUnavailableReason() !== null,
    unlock,
  };
}
