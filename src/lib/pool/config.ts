/**
 * Numera's own shielded pool, as the browser sees it.
 *
 * Replaces `unlink/config.ts`. The shape is deliberately the same — a discriminated union carrying
 * a *reason* rather than a bare `false` — because the wallet screen renders that string directly,
 * and "private trading is off" and "private trading is misconfigured" produce very different
 * support conversations.
 *
 * Every `process.env.NEXT_PUBLIC_*` is written as a full expression so Next inlines the literal at
 * build time on both server and client. Reading them dynamically (`process.env[name]`) yields
 * `undefined` in the browser, which here would silently disable the privacy layer in production
 * while working perfectly in development.
 */

export type PoolConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      /** `NumeraPoolEntrypoint`. The only address value is ever sent to. */
      readonly entrypoint: `0x${string}`;
      /** `PrivacyPool`. Read-only from the browser; the entrypoint speaks for it. */
      readonly privacyPool: `0x${string}`;
      readonly chainId: number;
      /** Where `/pool/state`, `/pool/withdraw` and `/pool/shield` live. Same origin by default. */
      readonly apiUrl: string;
    };

export interface PoolEnv {
  readonly enabled: string | undefined;
  readonly entrypoint: string | undefined;
  readonly privacyPool: string | undefined;
  readonly chainId: string | undefined;
  readonly apiUrl: string | undefined;
}

export const DEFAULT_CHAIN_ID = 10143;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate raw env into a config, or an explicit disabled reason.
 *
 * Pure and total — never throws. A misconfigured pool degrades to disabled; it must not take the
 * app down at import time, because this module is imported by the provider that wraps every page.
 */
export function resolvePoolConfig(env: PoolEnv): PoolConfig {
  if (env.enabled !== 'true') {
    return {
      enabled: false,
      reason: 'Private trading is disabled on this deployment.',
    };
  }

  const entrypoint = env.entrypoint?.trim();
  if (!entrypoint || !ADDRESS.test(entrypoint)) {
    return {
      enabled: false,
      // Not a soft failure. The entrypoint is inside the EIP-712 domain every gasless return is
      // signed against, so a wrong one produces signatures that verify nowhere.
      reason: 'NEXT_PUBLIC_POOL_ENTRYPOINT must be a contract address for private trading.',
    };
  }

  const privacyPool = env.privacyPool?.trim();
  if (!privacyPool || !ADDRESS.test(privacyPool)) {
    return {
      enabled: false,
      reason: 'NEXT_PUBLIC_PRIVACY_POOL must be a contract address for private trading.',
    };
  }

  const chainId = env.chainId ? Number(env.chainId) : DEFAULT_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { enabled: false, reason: 'NEXT_PUBLIC_CHAIN_ID must be a positive integer.' };
  }

  return {
    enabled: true,
    entrypoint: entrypoint as `0x${string}`,
    privacyPool: privacyPool as `0x${string}`,
    chainId,
    apiUrl: env.apiUrl?.trim() || '',
  };
}

export const POOL_CONFIG = resolvePoolConfig({
  enabled: process.env.NEXT_PUBLIC_POOL_ENABLED,
  entrypoint: process.env.NEXT_PUBLIC_POOL_ENTRYPOINT,
  privacyPool: process.env.NEXT_PUBLIC_PRIVACY_POOL,
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
  apiUrl: process.env.NEXT_PUBLIC_API_URL,
});

/**
 * Where the proving artifacts are served from.
 *
 * Fetched over HTTP rather than imported, because `withdraw.zkey` is 17MB and an `import` would
 * inline it into a bundle every visitor downloads whether or not they ever place a bet. See
 * `public/zk/README.md` for the one invariant that binds these to the deployed verifier.
 */
export const ZK_ARTIFACTS = {
  wasm: '/zk/withdraw.wasm',
  zkey: '/zk/withdraw.zkey',
} as const;

/** The BN254 scalar field. Every value in a witness must be reduced into it. */
export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** `MAX_TREE_DEPTH` in the circuit. Sibling arrays are padded to exactly this length. */
export const MAX_TREE_DEPTH = 32;
