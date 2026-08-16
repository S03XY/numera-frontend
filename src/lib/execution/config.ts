/**
 * Execution-layer configuration: the forwarder, and where to send signed trades.
 *
 * Kept apart from `unlink/config.ts` on purpose. That file configures the *pool*, which is the piece
 * we intend to replace; this configures the part we own. Mixing them is how a swap of one turns into
 * a rewrite of both.
 *
 * Every `process.env.NEXT_PUBLIC_*` is written as a full expression so Next inlines the literal at
 * build time on both server and client. Reading them dynamically (`process.env[name]`) yields
 * `undefined` in the browser.
 */

export type ExecutionConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      /** `NumeraForwarder`. The only contract that may speak for a market account. */
      readonly forwarder: `0x${string}`;
      /** Where signed requests go. Same origin by default. */
      readonly relayUrl: string;
      readonly chainId: number;
    };

export interface ExecutionEnv {
  readonly enabled: string | undefined;
  readonly forwarder: string | undefined;
  readonly relayUrl: string | undefined;
  readonly chainId: string | undefined;
}

export const DEFAULT_CHAIN_ID = 10143;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate raw env into a config, or an explicit disabled reason.
 *
 * A *reason* rather than a bare `false`, because "gasless trading is off" and "gasless trading is
 * misconfigured" produce very different support conversations, and the wallet screen shows this
 * string directly.
 *
 * Pure and total — never throws. A misconfigured relay degrades to disabled; it must not take the
 * app down at import time.
 */
export function resolveExecutionConfig(env: ExecutionEnv): ExecutionConfig {
  if (env.enabled !== 'true') {
    return {
      enabled: false,
      reason: 'Gasless trading is disabled (NEXT_PUBLIC_RELAY_ENABLED is not "true").',
    };
  }

  const forwarder = env.forwarder?.trim();
  if (!forwarder || !ADDRESS.test(forwarder)) {
    return {
      enabled: false,
      // Not a soft failure: with the wrong forwarder every signature is produced against the wrong
      // EIP-712 domain and fails verification on chain, with no error that says why.
      reason: 'NEXT_PUBLIC_NUMERA_FORWARDER must be a contract address when the relay is enabled.',
    };
  }

  const chainId = env.chainId ? Number(env.chainId) : DEFAULT_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { enabled: false, reason: 'NEXT_PUBLIC_CHAIN_ID must be a positive integer.' };
  }

  return {
    enabled: true,
    forwarder: forwarder as `0x${string}`,
    relayUrl: env.relayUrl?.trim() || '',
    chainId,
  };
}

export const EXECUTION_CONFIG = resolveExecutionConfig({
  enabled: process.env.NEXT_PUBLIC_RELAY_ENABLED,
  forwarder: process.env.NEXT_PUBLIC_NUMERA_FORWARDER,
  relayUrl: process.env.NEXT_PUBLIC_API_URL,
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
});

/**
 * The second relay: proposing and disputing an outcome, from the same market account that traded.
 *
 * Separate config because it degrades separately. A trader with no trading relay cannot bet at all —
 * funding a market account publicly is exactly what the design forbids — whereas a trader with no
 * resolution relay can still watch the market get settled by the operator. So this being off is a
 * missing feature, not a broken product, and it must not disable trading.
 */
export type ResolutionConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      /** `ResolutionForwarder`. The only contract that may propose on a market account's behalf. */
      readonly forwarder: `0x${string}`;
      /** `OptimisticResolver`. The forwarder's single frozen destination, and the bond's spender. */
      readonly resolver: `0x${string}`;
      readonly relayUrl: string;
      readonly chainId: number;
    };

export interface ResolutionEnv {
  readonly enabled: string | undefined;
  readonly forwarder: string | undefined;
  readonly resolver: string | undefined;
  readonly relayUrl: string | undefined;
  readonly chainId: string | undefined;
}

/** Same shape and the same total, never-throws contract as {@link resolveExecutionConfig}. */
export function resolveResolutionConfig(env: ResolutionEnv): ResolutionConfig {
  if (env.enabled !== 'true') {
    return {
      enabled: false,
      reason: 'Sponsored resolution is disabled (NEXT_PUBLIC_RELAY_ENABLED is not "true").',
    };
  }

  const forwarder = env.forwarder?.trim();
  if (!forwarder || !ADDRESS.test(forwarder)) {
    return {
      enabled: false,
      // The forwarder address is part of the EIP-712 domain separator, so a wrong one produces a
      // signature that verifies nowhere and fails with nothing that points at the cause.
      reason: 'NEXT_PUBLIC_RESOLUTION_FORWARDER must be a contract address to propose privately.',
    };
  }

  const resolver = env.resolver?.trim();
  if (!resolver || !ADDRESS.test(resolver)) {
    return {
      enabled: false,
      reason: 'NEXT_PUBLIC_OPTIMISTIC_RESOLVER must be a contract address to propose privately.',
    };
  }

  const chainId = env.chainId ? Number(env.chainId) : DEFAULT_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { enabled: false, reason: 'NEXT_PUBLIC_CHAIN_ID must be a positive integer.' };
  }

  return {
    enabled: true,
    forwarder: forwarder as `0x${string}`,
    resolver: resolver as `0x${string}`,
    relayUrl: env.relayUrl?.trim() || '',
    chainId,
  };
}

export const RESOLUTION_CONFIG = resolveResolutionConfig({
  enabled: process.env.NEXT_PUBLIC_RELAY_ENABLED,
  forwarder: process.env.NEXT_PUBLIC_RESOLUTION_FORWARDER,
  resolver: process.env.NEXT_PUBLIC_OPTIMISTIC_RESOLVER,
  relayUrl: process.env.NEXT_PUBLIC_API_URL,
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
});
