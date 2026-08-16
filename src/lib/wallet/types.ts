import type { LocalAccount } from 'viem';

/**
 * A minimal signer abstraction.
 *
 * Auth only needs an address plus EIP-191 `signMessage`, so a Mera passkey
 * account, an injected wallet, and a test double are all interchangeable here.
 * Keeping this narrow is what lets the login flow be signer-agnostic.
 */
export interface WalletSigner {
  address: string;
  /**
   * How this signer was obtained.
   *
   * Several flows (unlocking Unlink, the faucet, depositing, settling) have to
   * re-acquire a signer after login, and they must re-acquire the SAME one — a
   * passkey prompt shown to someone who signed in with MetaMask would derive a
   * different identity and silently strand their funds. See `reconnectWallet`.
   */
  kind: WalletKind;
  /**
   * Which passkey produced this signer, base64url. Passkeys only.
   *
   * Remembered at sign-in and pinned on every later assertion. Without it WebAuthn is free to pick
   * any discoverable credential for the site, and a second passkey derives a different key, a
   * different address and a different shielded balance — all of them valid, none of them the one
   * the session was built on.
   */
  credentialId?: string;
  signMessage(message: string): Promise<string>;
  /**
   * The underlying viem account, when the signer holds the key locally.
   *
   * Auth and Unlink identity derivation need only `signMessage`, which is why
   * that stays the core contract. Depositing into the shielded pool needs more:
   * an EIP-712 signature for Permit2 and a real transaction for the ERC-20
   * approval. Mera's session satisfies both (it adapts to a full viem
   * `LocalAccount`), so this exposes it for those flows without widening the
   * interface every signer must implement.
   *
   * Injected wallets never set this — they keep their key and sign over RPC, so
   * they expose {@link provider} instead. Use `signerWalletClient` rather than
   * reading either field directly.
   */
  evmAccount?: LocalAccount;
  /**
   * The wallet's own EIP-1193 provider, for injected signers.
   *
   * Passed straight to Unlink's `account.fromWallet`, which is written against
   * exactly this interface — wrapping it would only add a place for the
   * `personal_sign` encoding to drift.
   */
  provider?: Eip1193Provider;
  /** Releases in-memory key material (Mera signing sessions). Optional. */
  disconnect?(): void;
}

/** The slice of EIP-1193 this app uses. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export type WalletKind = 'passkey' | 'injected';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletError';
    this.code = code;
  }
}

export type WalletErrorCode =
  | 'UNSUPPORTED' // no WebAuthn / no injected provider
  | 'CANCELLED' // user dismissed the passkey or wallet prompt
  | 'DERIVATION_FAILED'
  | 'SIGN_FAILED'
  | 'SMART_ACCOUNT' // contract wallet; Unlink v1 needs a plain EOA
  | 'WRONG_NETWORK' // wallet refused to move to Monad testnet
  /**
   * The extension is on a different account than the one this session was built on.
   *
   * Its own code rather than a `SIGN_FAILED`, because it is the only failure here that is fixed by
   * a decision instead of a retry: either switch the wallet back, or sign in as the new account
   * and open its separate private balance. See `reconnectWallet`.
   */
  | 'WRONG_ACCOUNT'
  /**
   * A wallet dialog is already open for this origin, so this request was refused rather than
   * queued behind it.
   *
   * Distinct from `UNSUPPORTED`, which is where it used to land, and the copy is why: the advice
   * attached to `UNSUPPORTED` on the reconnect path is "unlock the MetaMask extension", which is
   * exactly wrong for a request that is waiting on a window the user has not looked at yet.
   */
  | 'REQUEST_PENDING'
  | 'PRF_UNAVAILABLE'; // passkey store cannot derive keys (no WebAuthn PRF)

/** Map an unknown throw from a wallet/passkey ceremony to a typed error. */
export function toWalletError(err: unknown, fallback: WalletErrorCode = 'SIGN_FAILED'): WalletError {
  if (err instanceof WalletError) return err;
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? 'Wallet request failed';
  // WebAuthn cancellation and EIP-1193 user rejection (4001) are not failures —
  // they are the user saying no, and must not surface as scary errors.
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new WalletError('CANCELLED', 'Request cancelled.', { cause: err });
  }
  if ((err as { code?: number })?.code === 4001) {
    return new WalletError('CANCELLED', 'Request rejected in wallet.', { cause: err });
  }
  // MetaMask serves one dialog per origin at a time and refuses the second outright. Left
  // unmapped this surfaced its raw internal string, `Request of type 'wallet_requestPermissions'
  // already pending for origin ...`, straight into the sign-in panel.
  if ((err as { code?: number })?.code === -32002) {
    return new WalletError(
      'REQUEST_PENDING',
      'MetaMask is already asking. Open the extension window to answer, then try again.',
      { cause: err },
    );
  }
  return new WalletError(fallback, message, { cause: err });
}
