import { findInjectedWallet } from './injected';
import { readWalletPreference } from './reconnect';
import type { Eip1193Provider } from './types';

/**
 * Watching the wallet for the account it is actually on.
 *
 * ## The bug this exists for
 *
 * `connectInjectedWallet` reads `eth_requestAccounts` once and bakes the address it got into the
 * signer it returns. Nothing ever looked at that address again. So switching accounts in MetaMask
 * changed nothing here: the header kept the old one, the session stayed signed in as the old one,
 * and the only way to move was to sign out and back in — which is the complaint, and it is the
 * *small* half of the problem.
 *
 * The large half is that the site kept working. Every later flow that needs a key calls
 * `reconnectWallet`, which asks the extension for accounts again and gets whatever is selected
 * *now*. Unlocking after switching accounts therefore derived a shielded identity from a different
 * key, and a different key is a different private balance: valid, empty, and with the real one
 * nowhere on screen. No error, because nothing was wrong — the site had simply been handed a
 * different person and had no way to notice.
 *
 * So the address is watched, and `reconnectWallet` is pinned to the one the session was built on.
 * This file is the watching half.
 *
 * ## Why it does not just follow the wallet
 *
 * The obvious "smooth" behaviour is to swap the session over silently. That is the one thing it
 * must not do. The signed-in address *is* the account: it identifies the user to the backend and it
 * seeds the shielded identity. Following the wallet without saying so would move somebody's money
 * view out from under them mid-trade. Instead the change is detected immediately and offered as one
 * button, which is as smooth as this can honestly be.
 */

/** `accountsChanged` hands back an array of addresses; anything else means "no account". */
function firstAddress(accounts: unknown): string | null {
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first : null;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Report the wallet's selected account, now and whenever it changes.
 *
 * Reads through `eth_accounts` rather than `eth_requestAccounts`: this runs unprompted on every
 * page load for a signed-in user, and the requesting form opens the extension's approval dialog. A
 * site that pops MetaMask open by itself on load is a site people stop trusting.
 *
 * Returns an unsubscribe. Safe to call when no wallet is involved — a passkey session subscribes to
 * nothing and the teardown is a no-op.
 */
export function watchWalletAccount(onChange: (address: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const preference = readWalletPreference();
  // A passkey has no selected account to drift: the credential is the identity, and it cannot be
  // switched behind the app's back.
  if (preference?.kind !== 'injected') return () => {};

  let provider: Eip1193Provider | null = null;
  let listener: ((accounts: unknown) => void) | null = null;
  let cancelled = false;

  void (async () => {
    const wallet = await findInjectedWallet(preference.rdns ?? '');
    // Not an error worth reporting. The extension may be locked, disabled for this site, or still
    // waking up, and none of those mean the session is wrong — they mean there is nothing to watch.
    if (!wallet || cancelled) return;

    const bound = wallet.provider;
    provider = bound;
    listener = (accounts: unknown) => onChange(firstAddress(accounts));
    bound.on?.('accountsChanged', listener as (...args: unknown[]) => void);

    const current = await bound.request({ method: 'eth_accounts' }).catch(() => null);
    if (!cancelled) onChange(firstAddress(current));
  })();

  return () => {
    cancelled = true;
    if (provider && listener) {
      provider.removeListener?.('accountsChanged', listener as (...args: unknown[]) => void);
    }
  };
}
