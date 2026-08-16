import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { WalletSigner } from '@/lib/wallet/types';

/**
 * The keys behind Numera's own execution accounts.
 *
 * ## What an execution account is, and why it is derived rather than allocated
 *
 * Every (user, market) pair trades through its own address. That address — not the user — is what
 * the contracts see, and breaking the link between the two is the entire product. Collateral
 * reaches it by a shielded-pool withdrawal, whose *source account is private*, so nothing on chain
 * connects the trader to the position.
 *
 * Unlink allocated those accounts server-side and handed back a slot index, which meant the
 * market→account mapping was a cache: losing it lost the ability to claim, and rebuilding it meant
 * asking their backend which accounts we owned. Deriving instead makes the account a pure function
 * of `(root secret, market id)`. There is nothing to store, nothing to lose, nothing to ask anyone
 * for, and no slot to be locked by a session someone else's infrastructure failed to close.
 *
 * ## Where the root secret comes from
 *
 * One `personal_sign` over a canonical, versioned message — the same construction Unlink uses for
 * its own identity, and deliberately a *separate* message from theirs:
 *
 *     Numera: derive market accounts
 *     App: numera
 *     Chain: 10143
 *     Version: 1
 *
 * Separate because these accounts must outlive any decision about the shielded pool. Deriving them
 * from Unlink's spending key would entangle the two, and replacing the pool later would strand
 * every position behind an identity we no longer generate. A signature the user's own wallet
 * produces belongs to the user, not to a vendor.
 *
 * Deterministic all the way down, so the same passkey on any device reproduces every market
 * account with no server-side recovery data:
 *
 *     passkey/wallet → personal_sign(canonical message) → HKDF-SHA256 → per-market secp256k1 key
 *
 * ## What an attacker gets from one leaked key
 *
 * HKDF is one-way and each market is a separate `info` string, so a leaked market key reveals
 * neither the root nor any sibling market. The blast radius is that market's float — the
 * collateral currently parked in it — and never the shielded balance behind it, which only the
 * Unlink spending key can move. That bound is why per-market derivation is worth the extra keys.
 *
 * **The root secret must never be sent anywhere.** Not to our backend, not to Unlink's. A server
 * that learns a market account alongside an authenticated session has reconstructed exactly the
 * link this file exists to break — see `docs` on the relayer in the execution layer for why the
 * gas path is unauthenticated for the same reason.
 */

/**
 * The message signed to derive every market account, and the one thing here that can never change
 * casually.
 *
 * Bumping `Version` re-derives every account for every user: their positions stay on chain and
 * remain claimable, but the app would look at a different set of addresses and see nothing. Treat
 * it as a migration, not a constant. Chain id is included so the same wallet on another network
 * cannot produce colliding accounts.
 */
export function marketAccountMessage(params: { appId: string; chainId: number }): string {
  return [
    'Numera: derive market accounts',
    `App: ${params.appId}`,
    `Chain: ${params.chainId}`,
    'Version: 1',
  ].join('\n');
}

/** Opaque root secret for one user on one chain. Never leaves the browser. */
export type ExecutionRoot = Hex & { readonly __brand: 'ExecutionRoot' };

/**
 * Derive the root secret from a wallet signature.
 *
 * The signature is hashed rather than used directly: it is 65 bytes with structure (r, s, v), and
 * HKDF wants uniform input keying material. `keccak256` gives 32 uniform bytes and discards the
 * malleable parts.
 */
export async function deriveExecutionRoot(params: {
  signer: WalletSigner;
  appId: string;
  chainId: number;
}): Promise<ExecutionRoot> {
  const message = marketAccountMessage({ appId: params.appId, chainId: params.chainId });
  const signature = await params.signer.signMessage(message);

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    // A wallet that returns a short or malformed signature would still hash to *something*,
    // producing accounts that look fine and cannot be reproduced by a correct wallet later.
    throw new ExecutionKeyError(
      'This wallet returned a signature Numera cannot derive from. Reconnect and try again.',
    );
  }

  return keccak256(signature as Hex) as ExecutionRoot;
}

export class ExecutionKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutionKeyError';
  }
}

/** Domain separation for HKDF. Distinct per market, so siblings are independent. */
function infoFor(marketRef: string): Uint8Array {
  return new TextEncoder().encode(`numera:market-account:v1:${marketRef}`);
}

/**
 * The private key for one market's execution account.
 *
 * HKDF-SHA256 with the market id as `info`, so every market gets an independent key from one root
 * and no market's key says anything about another's.
 *
 * secp256k1 requires `0 < k < n`. HKDF output is uniform over 2^256, so a value outside that range
 * is astronomically unlikely — but "astronomically unlikely" is not "impossible", and a key of
 * zero would be a silent catastrophe rather than an error. The counter makes it total.
 */
export function marketAccountKey(root: ExecutionRoot, marketRef: string): Hex {
  if (!marketRef) throw new ExecutionKeyError('A market reference is required to derive an account.');

  const ikm = hexToBytes(root);
  const salt = new TextEncoder().encode('numera:market-account:v1');

  for (let counter = 0; counter < 256; counter += 1) {
    const info = counter === 0 ? infoFor(marketRef) : infoFor(`${marketRef}#${counter}`);
    const key = toHex(hkdf(sha256, ikm, salt, info, 32));
    if (isValidSecp256k1Key(key)) return key;
  }
  // Unreachable in any universe we will trade in; throwing beats returning something unusable.
  throw new ExecutionKeyError('Could not derive a valid key for this market.');
}

/** The curve order. A key must be in `[1, n)`. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function isValidSecp256k1Key(key: Hex): boolean {
  const value = BigInt(key);
  return value > 0n && value < SECP256K1_N;
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The signing account for one market.
 *
 * Returned rather than cached: callers hold it for the duration of one operation and drop it. A
 * module-level cache of live signing accounts is a larger attack surface than a few microseconds
 * of key derivation is worth.
 */
export function marketAccount(root: ExecutionRoot, marketRef: string): PrivateKeyAccount {
  return privateKeyToAccount(marketAccountKey(root, marketRef));
}

/**
 * The address alone, for display and for reads.
 *
 * Separate from {@link marketAccount} so the common case — showing a balance, checking an
 * allowance — never materialises a signer at all.
 */
export function marketAccountAddress(root: ExecutionRoot, marketRef: string): `0x${string}` {
  return marketAccount(root, marketRef).address;
}
