'use client';

import * as React from 'react';
import { usePool } from '@/lib/pool/PoolProvider';
import { useShieldedPool } from '@/lib/pool/useShieldedPool';
import { publicClient } from '@/lib/chain/evm';
import { httpRelay, type TradeContext } from './trading';
import { EXECUTION_CONFIG } from './config';
import type { GasProvider } from './market-account';

/**
 * Nothing to do: a market account never holds native gas.
 *
 * The account signs and `NumeraForwarder` sends, so there is no balance to top up and no funding
 * path to get wrong. That is not an optimisation — a gas transfer from the user's wallet to their
 * market account would publish the link between them permanently, so the correct amount of gas for
 * a market account to hold is exactly zero, forever.
 *
 * Kept as an explicit no-op rather than deleted from {TradeContext}: the interface documents an
 * invariant, and an implementation that visibly does nothing is the clearest statement of it.
 */
const RELAYED: GasProvider = { ensure: async () => undefined };

export interface ExecutionParams {
  /** Backend market UUID — the account-derivation input, not the on-chain id. */
  marketRef: string;
  /** The engine contract, and the only address the forwarder will call. */
  engine: string;
  /** Collateral token address. */
  token: string;
}

/**
 * Everything a trade needs, or `null` when the session is locked.
 *
 * `null` is a normal state, not an error: the user has simply not unlocked yet. Callers offer the
 * passkey rather than reporting a fault.
 */
export function useExecution(params: ExecutionParams): TradeContext | null {
  const { executionRoot } = usePool();
  const pool = useShieldedPool();
  const { marketRef, engine, token } = params;

  return React.useMemo(() => {
    if (!pool || !executionRoot || !EXECUTION_CONFIG.enabled) return null;

    return {
      pool,
      root: executionRoot,
      gas: RELAYED,
      marketRef,
      token,
      relay: httpRelay(EXECUTION_CONFIG.relayUrl),
      rpc: publicClient(),
      chainId: EXECUTION_CONFIG.chainId,
      forwarder: EXECUTION_CONFIG.forwarder,
      engine: engine as `0x${string}`,
    };
  }, [pool, executionRoot, marketRef, engine, token]);
}

/** Why gasless trading is unavailable here, or `null` when it is fine. */
export function executionUnavailableReason(): string | null {
  return EXECUTION_CONFIG.enabled ? null : EXECUTION_CONFIG.reason;
}
