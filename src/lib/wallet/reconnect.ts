import { connectPasskeyWallet } from './mera';
import { connectInjectedWallet, findInjectedWallet } from './injected';
import { WalletError, type WalletKind, type WalletSigner } from './types';

/**
 * Re-acquiring the signer the user actually signed in with.
 *
 * Logging in deliberately destroys the signer: `loginWithSigner` zeroes the
 * passkey session the moment SIWE completes, because holding a spending key in
 * memory for a whole session to save one prompt is a bad trade. Everything that
 * needs a key later — unlocking Unlink, the faucet, depositing, settling — has
 * to ask for it again.
 *
 * Before external wallets existed, "ask again" meant `connectPasskeyWallet()`,
 * hardcoded in four places. With two account types that becomes a real bug: a
 * MetaMask user prompted for a passkey would derive a DIFFERENT shielded
 * identity, and any funds already inside the pool would become unreachable —
 * silently, with no error, because both identities are perfectly valid.
 *
 * So the choice is remembered and every one of those call sites goes through
 * {@link reconnectWallet}.
 */

const KEY = 'numera.wallet.preference';

export interface WalletPreference {
  kind: WalletKind;
  /** EIP-6963 rdns of the chosen extension, for `kind: 'injected'`. */
  rdns?: string;
  /**
   * Which passkey signed in, base64url. Pinned on every later assertion.
   *
   * Not a secret: a credential id is a public handle that identifies a passkey to the browser and
   * cannot be used to sign anything. Storing it is what stops WebAuthn picking a *different* one
   * later and silently opening a second, empty identity.
   */
  credentialId?: string;
}

/**
 * Nothing secret is stored — only which *sort* of key the user has, and which
 * extension announced it. An attacker reading this learns that someone uses
 * MetaMask on this device, which they could see from the extension anyway.
 */
export function rememberWallet(preference: WalletPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(preference));
  } catch {
    // Private browsing or a full quota. The user simply gets asked which wallet
    // to use next time, which is a far better outcome than failing the login.
  }
}

export function readWalletPreference(): WalletPreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const kind = (parsed as { kind?: unknown })?.kind;
    if (kind !== 'passkey' && kind !== 'injected') return null;
    const rdns = (parsed as { rdns?: unknown }).rdns;
    const credentialId = (parsed as { credentialId?: unknown }).credentialId;
    return {
      kind,
      ...(typeof rdns === 'string' ? { rdns } : {}),
      ...(typeof credentialId === 'string' ? { credentialId } : {}),
    };
  } catch {
    return null;
  }
}

export function forgetWallet(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do; the value is advisory.
  }
}

/**
 * Reconnect the wallet this browser last signed in with.
 *
 * Falls back to the passkey when nothing is remembered — that is the path a
 * first-time visitor is on, and it is the only one that can succeed without the
 * user first choosing an extension.
 *
 * @param expect The address the session was built on. Passing it turns a wallet that has since
 *        switched accounts into a refusal instead of a silent identity swap; see below.
 */
export async function reconnectWallet(expect?: string | null): Promise<WalletSigner> {
  const preference = readWalletPreference();

  if (preference?.kind === 'injected') {
    const wallet = await findInjectedWallet(preference.rdns ?? '');
    if (!wallet) {
      // Deliberately not "connect a different wallet instead". The signed-in identity was derived
      // from this exact key, so any other wallet reaches a different shielded balance — the
      // suggestion that sounds helpful is the one that loses the money.
      throw new WalletError(
        'UNSUPPORTED',
        'The wallet you signed in with is not available. Unlock the MetaMask extension (or ' +
          're-enable it for this site) and try again — signing in with a different wallet would ' +
          'open a different private balance.',
      );
    }

    const signer = await connectInjectedWallet(wallet);

    /*
      The same argument as the missing-wallet case above, one level down, and the one that was
      actually reachable.

      Matching on rdns only ever established that this is the same *extension*. It says nothing
      about which of that extension's accounts is selected, and the account is what derives the
      shielded identity. So switching accounts in MetaMask and then unlocking used to open a
      different private balance: valid, empty, and with the real one nowhere on screen. Nothing
      failed, because from the code's point of view nothing had.

      Refusing is the whole fix. The caller turns this into an offer to sign in as the new account,
      which is a decision the person can actually make.
    */
    if (expect && signer.address.toLowerCase() !== expect.toLowerCase()) {
      throw new WalletError(
        'WRONG_ACCOUNT',
        `Your wallet has switched to ${short(signer.address)}, but you are signed in as ` +
          `${short(expect)}. Switch back to ${short(expect)} in MetaMask, or sign in again as ` +
          'the new account — each account has its own separate private balance.',
      );
    }

    return signer;
  }

  // Pinned to the passkey that signed in, so the browser offers no choice to get wrong.
  const signer = await connectPasskeyWallet(preference?.credentialId);

  /*
    The same check as the injected path, and it was missing here.

    A passkey derives its address from the PRF output of one specific credential. If more than one
    passkey is registered for this domain — a second device enrolled, a re-registration after a
    lost phone, a duplicate created by a password manager — the browser picks which one to use,
    and a different credential is a different key and therefore a different address.

    Nothing about that is detectable downstream. The derived account is perfectly valid, so the
    faucet, the deposit and the shielded balance all address themselves to an account the user has
    never funded and cannot see, while the wallet screen keeps showing the funded one from their
    session. What that looks like in practice is "I sent it 1 MON and it still says I have none",
    which is exactly right and impossible to act on.

    Refusing names both addresses instead. The caller offers signing in again as the account the
    passkey actually opened, which is a decision the person can make.
  */
  if (expect && signer.address.toLowerCase() !== expect.toLowerCase()) {
    signer.disconnect?.();
    throw new WalletError(
      'WRONG_ACCOUNT',
      `That passkey opens ${short(signer.address)}, but you are signed in as ${short(expect)}. ` +
        'If you have more than one passkey for this site, choose the other one — or sign out and ' +
        'sign in again with this one, which is a separate account with its own private balance.',
    );
  }

  return signer;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
