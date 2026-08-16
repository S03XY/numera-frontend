'use client';

import * as React from 'react';
import { usePool } from '@/lib/pool/PoolProvider';
import { publicClient } from '@/lib/chain/evm';
import { RESOLUTION_CONFIG } from './config';
import {
  disputeOutcome,
  httpResolutionRelay,
  proposeOutcome,
  type ResolutionContext,
} from './resolution';
import { ExecutionError } from './market-account';

export interface ResolutionParams {
  /** Backend market UUID — the account-derivation input, not the on-chain id. */
  marketRef: string;
  /** The engine contract the market lives on. */
  engine: string;
  /** Collateral token address. */
  token: string;
}

/**
 * Everything a proposal needs, or `null` when it cannot be made privately.
 *
 * `null` is a normal state and covers two very different situations that the caller should treat
 * the same way: the session is locked, or sponsored resolution is not configured. In both cases the
 * honest answer to the trader is "you cannot do this from here", not an error — the market still
 * gets settled, by the operator, and nothing is broken.
 */
export function useResolutionContext(params: ResolutionParams): ResolutionContext | null {
  const { executionRoot } = usePool();
  const { marketRef, engine, token } = params;

  return React.useMemo(() => {
    if (!executionRoot || !RESOLUTION_CONFIG.enabled) return null;
    return {
      root: executionRoot,
      marketRef,
      token,
      rpc: publicClient(),
      chainId: RESOLUTION_CONFIG.chainId,
      relay: httpResolutionRelay(RESOLUTION_CONFIG.relayUrl),
      forwarder: RESOLUTION_CONFIG.forwarder,
      resolver: RESOLUTION_CONFIG.resolver,
      engine: engine as `0x${string}`,
    };
  }, [executionRoot, marketRef, engine, token]);
}

export type ResolutionActionResult =
  | { ok: true; hash: string; account: string }
  | { ok: false; message: string; pending: boolean };

/**
 * Propose or dispute an outcome from this market's shielded account.
 *
 * `pending` on a failure is the field that matters. The relayer simulates before it broadcasts, so
 * a rejection means nothing was staked and retrying is safe — but a request that was submitted and
 * has not settled is a different animal, and telling a trader it failed is how they end up staking
 * twice on the same market.
 */
export function useResolutionActions(params: ResolutionParams) {
  const ctx = useResolutionContext(params);
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(
    async (fn: () => Promise<{ hash: string; account: string }>): Promise<ResolutionActionResult> => {
      setBusy(true);
      try {
        const { hash, account } = await fn();
        return { ok: true, hash, account };
      } catch (err) {
        const pending = err instanceof ExecutionError && err.code === 'pending';
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Something went wrong.',
          pending,
        };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const propose = React.useCallback(
    (args: { marketId: bigint; outcomeId: number | null; stake: bigint }) => {
      if (!ctx) {
        return Promise.resolve<ResolutionActionResult>({
          ok: false,
          message: unavailableReason(),
          pending: false,
        });
      }
      return run(() => proposeOutcome(ctx, args));
    },
    [ctx, run],
  );

  const dispute = React.useCallback(
    (args: { marketId: bigint; counterOutcomeId: number | null; stake: bigint }) => {
      if (!ctx) {
        return Promise.resolve<ResolutionActionResult>({
          ok: false,
          message: unavailableReason(),
          pending: false,
        });
      }
      return run(() => disputeOutcome(ctx, args));
    },
    [ctx, run],
  );

  return { propose, dispute, busy, available: ctx !== null };
}

/** Why proposing is unavailable here, or `null` when it is fine. */
export function resolutionUnavailableReason(): string | null {
  return RESOLUTION_CONFIG.enabled ? null : RESOLUTION_CONFIG.reason;
}

function unavailableReason(): string {
  return RESOLUTION_CONFIG.enabled
    ? 'Unlock your account to take part in settling this market.'
    : RESOLUTION_CONFIG.reason;
}
