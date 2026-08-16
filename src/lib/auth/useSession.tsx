'use client';

import * as React from 'react';
import { tokenStore } from '@/lib/api/token-store';
import { endpoints } from '@/lib/api/endpoints';
import { loginWithSigner, logout as doLogout } from './login';
import { connectPasskeyWallet, createPasskeyWallet, type PasskeyStore } from '@/lib/wallet/mera';
import {
  connectInjectedWallet,
  findInjectedWallet,
  requestAccountAccess,
  type InjectedWallet,
} from '@/lib/wallet/injected';
import { forgetWallet, readWalletPreference, rememberWallet } from '@/lib/wallet/reconnect';
import { sameAddress, watchWalletAccount } from '@/lib/wallet/watch';
import {
  toWalletError,
  WalletError,
  type WalletErrorCode,
  type WalletSigner,
} from '@/lib/wallet/types';
// Always the real passkey. A stand-in signer used to be substituted under a preview flag; it is
// gone, because a signer that produces a session without a real credential is exactly the thing
// that must never be reachable from a shipped build.
const signUpWallet = createPasskeyWallet;
const signInWallet = connectPasskeyWallet;

/** Said when the extension that signed this browser in is no longer answering. */
const WALLET_GONE =
  'MetaMask did not answer. Unlock the extension, or re-enable it for this site, and try again.';

/** Said when the wallet has no way to reopen its own account picker. */
const CANNOT_REOFFER =
  'This wallet cannot reopen its account list from a website. Open the extension, connect the ' +
  'account you want to use, then come back.';

export interface SessionUser {
  id: string;
  address: string;
  displayName: string | null;
}

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface SessionContextValue {
  status: SessionStatus;
  user: SessionUser | null;
  error: string | null;
  /**
   * What kind of failure {@link error} is describing.
   *
   * Exposed so a panel can offer the one move that fixes a particular failure instead of a
   * paragraph of prose covering all of them. `PRF_UNAVAILABLE` is the case that earns it: the only
   * thing left to try is a different authenticator, and there is no way to ask for one by reading
   * the message.
   */
  errorCode: WalletErrorCode | null;
  /**
   * The account the browser wallet has selected right now, when signed in with one.
   *
   * Null for a passkey session, and null when no extension answered. Not the same thing as
   * {@link SessionUser.address}, which is the account this session was *built* on and never moves.
   */
  walletAccount: string | null;
  /**
   * The wallet has been switched to some other account since signing in.
   *
   * Worth its own field rather than left for callers to compute, because getting the comparison
   * wrong is silent: addresses arrive from the extension in mixed case, so `!==` reports a switch
   * on every page load for a user who has switched nothing.
   */
  walletSwitched: boolean;
  /**
   * This session signed in with a browser extension rather than a passkey.
   *
   * Separate from {@link walletAccount} being set, and the distinction is the point: a wallet that
   * has disconnected this site reports no account at all, which is precisely the state where
   * reopening its picker is the only way back. Gating the offer on the account would hide it
   * exactly then.
   */
  walletSession: boolean;
  /**
   * Create a new passkey account (signup).
   *
   * `store` is the retry after a passkey store that cannot derive keys: `'cross-device'` sends the
   * ceremony to a phone or a security key, which is the only authenticator a website can actually
   * ask for by name.
   */
  signUpWithPasskey: (store?: PasskeyStore) => Promise<void>;
  /** Sign in with an existing passkey. */
  signInWithPasskey: () => Promise<void>;
  /** Sign in with a browser-extension wallet the user picked. */
  signInWithInjected: (wallet: InjectedWallet) => Promise<void>;
  /** Sign in with any signer (tests, future connectors). */
  signInWithSigner: (signer: WalletSigner) => Promise<void>;
  /**
   * Adopt the account the wallet has switched to, as a fresh session.
   *
   * A sign-in rather than a swap, because that is what it is: a different key, a different backend
   * identity, and a different shielded balance. Doing it in one press is the whole improvement —
   * the old way out was sign out, reopen the panel, pick MetaMask, sign.
   */
  useSwitchedAccount: () => Promise<void>;
  /**
   * Reopen the wallet's account picker while signed in, without signing in again.
   *
   * The missing exit. Every other route to a different account went through signing out, and
   * signing out is not what the user wants: they want to look at a different account. This asks
   * the extension to re-offer its accounts, and nothing else. Whatever they grant arrives as an
   * `accountsChanged`, which is what {@link walletSwitched} is watching for, so the existing
   * "Continue as 0x..." offer picks it up and the decision stays theirs.
   */
  chooseAccount: () => Promise<void>;
  signOut: () => Promise<void>;
  busy: boolean;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<SessionStatus>('loading');
  const [user, setUser] = React.useState<SessionUser | null>(null);
  /*
    The message and its code, held together.

    One field rather than two, because they are one fact. Kept apart they drift: a `setError` added
    without a matching `setErrorCode` leaves a stale code attached to a fresh message, and the panel
    then offers the retry for a failure that already went away.
  */
  const [failure, setFailure] = React.useState<{
    message: string;
    code: WalletErrorCode;
  } | null>(null);
  const error = failure?.message ?? null;
  const errorCode = failure?.code ?? null;
  const [busy, setBusy] = React.useState(false);
  /*
    The wallet's selected account, tagged with who it was observed for.

    Tagged rather than cleared on sign-out, because clearing means a `setState` in an effect body,
    which cascades a render — and because a bare address would survive into the *next* session and
    be compared against a new signed-in user, flashing a switched-account warning at somebody who
    had just switched deliberately. Reading it through the tag makes staleness unrepresentable.
  */
  const [watched, setWatched] = React.useState<{ forUser: string | null; address: string | null }>({
    forUser: null,
    address: null,
  });
  /*
    Whether this session's key lives in an extension.

    Read from the remembered preference rather than derived during render, because
    `readWalletPreference` touches localStorage: on the server it returns null and on the client it
    does not, so reading it in the render body is a hydration mismatch. Both writers below are
    inside async callbacks, so nothing here writes state synchronously from an effect.
  */
  const [walletSession, setWalletSession] = React.useState(false);

  // On boot: if a refresh token survives from a previous visit, restore the
  // session silently. This is the "just connect wallet, no signature" path.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.getRefresh()) {
        if (!cancelled) setStatus('anonymous');
        return;
      }
      try {
        const me = await endpoints.users.me();
        if (!cancelled) {
          setUser(me);
          setWalletSession(readWalletPreference()?.kind === 'injected');
          setStatus('authenticated');
        }
      } catch {
        if (!cancelled) {
          tokenStore.clear();
          setStatus('anonymous');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runLogin = React.useCallback(
    async (getSigner: () => Promise<WalletSigner>, remember?: { rdns?: string }) => {
    setBusy(true);
    setFailure(null);
    try {
      const signer = await getSigner();
      const result = await loginWithSigner(signer);
      // Recorded only after a *successful* login. Every later flow that needs a
      // key re-acquires it through this preference, so writing it optimistically
      // would leave a failed MetaMask attempt pointing the passkey user at the
      // wrong wallet — and a wrong wallet means a different shielded identity.
      rememberWallet({
        kind: signer.kind,
        ...(remember?.rdns ? { rdns: remember.rdns } : {}),
        // Which passkey this was. Every later re-acquisition pins to it, so a device with two
        // passkeys can no longer unlock into a different identity than it signed in with.
        ...(signer.credentialId ? { credentialId: signer.credentialId } : {}),
      });
      setUser(result.user);
      setWalletSession(signer.kind === 'injected');
      setStatus('authenticated');
    } catch (err) {
      const walletError = toWalletError(err);
      // A cancelled passkey prompt is a normal user action, not an error state.
      setFailure(
        walletError.code === 'CANCELLED'
          ? null
          : { message: walletError.message, code: walletError.code },
      );
      throw walletError;
    } finally {
      setBusy(false);
    }
    },
    [],
  );

  /*
    Follow the extension's selected account.

    Subscribed only while signed in, and only for a wallet session — a passkey has no selected
    account that can drift, because the credential *is* the identity. See `wallet/watch.ts` for
    what went wrong without this: the site kept the address it was handed at connect time, and
    every later key derivation quietly used whichever account was selected by then.
  */
  const signedIn = user?.address ?? null;
  React.useEffect(() => {
    if (status !== 'authenticated' || !signedIn) return;
    return watchWalletAccount((address) => setWatched({ forUser: signedIn, address }));
  }, [status, signedIn]);

  const walletAccount = watched.forUser === signedIn ? watched.address : null;

  // False whenever either side is unknown. A wallet that has not answered yet is not a wallet that
  // has switched, and reporting one during that gap would put a warning on screen on every load.
  const walletSwitched =
    status === 'authenticated' &&
    walletAccount !== null &&
    signedIn !== null &&
    !sameAddress(walletAccount, signedIn);

  const value = React.useMemo<SessionContextValue>(
    () => ({
      status,
      user,
      error,
      errorCode,
      busy,
      walletAccount,
      walletSwitched,
      walletSession,
      signUpWithPasskey: (store?: PasskeyStore) => runLogin(() => signUpWallet(undefined, store)),
      signInWithPasskey: () => runLogin(() => signInWallet()),
      // The one place the picker opens on the way in. Set here rather than passed down from the
      // button, so the component keeps calling `signInWithInjected(wallet)` and cannot accidentally
      // stop asking, and so no future caller of this method inherits a silent connect.
      signInWithInjected: (wallet: InjectedWallet) =>
        runLogin(() => connectInjectedWallet(wallet, { chooseAccount: true }), {
          rdns: wallet.rdns,
        }),
      signInWithSigner: (signer: WalletSigner) => runLogin(async () => signer),
      async useSwitchedAccount() {
        const preference = readWalletPreference();
        if (preference?.kind !== 'injected') return;

        // Held before the lookup, not after. `findInjectedWallet` always waits a fixed 300ms for
        // an EIP-6963 announcement, and `runLogin` only takes the flag once that resolves, so the
        // button sat live through the whole wait: a second press ran a second login and asked for
        // a second signature.
        setBusy(true);
        let wallet;
        try {
          wallet = await findInjectedWallet(preference.rdns ?? '');
        } finally {
          setBusy(false);
        }
        if (!wallet) {
          setFailure({ message: WALLET_GONE, code: 'UNSUPPORTED' });
          return;
        }

        // The address the button is currently offering. Captured before the await, because the
        // wallet can move again while this runs.
        const offered = walletAccount;

        // No picker here, on purpose. The user has already named the account by pressing
        // "Continue as 0x...", so reopening the choice asks a question they just answered. Worse,
        // the grant would fire `accountsChanged` mid flight and relabel the very button under
        // their finger.
        await runLogin(async () => {
          const signer = await connectInjectedWallet(wallet);
          // The wallet moved again between the render and the press. Signing in as a third
          // account nobody named would open a third private balance, silently, and both the one
          // they were in and the one they asked for would be off screen.
          if (offered && !sameAddress(signer.address, offered)) {
            throw new WalletError(
              'WRONG_ACCOUNT',
              `Your wallet moved again while that was loading. It is now on ` +
                `${signer.address.slice(0, 6)}\u2026${signer.address.slice(-4)}. Check the account in ` +
                `MetaMask and try again.`,
            );
          }
          return signer;
        }, { rdns: wallet.rdns });
      },
      async chooseAccount() {
        const preference = readWalletPreference();
        if (preference?.kind !== 'injected') return;

        setBusy(true);
        setFailure(null);
        try {
          // Inside the busy window, because the announcement wait is most of the delay the user
          // feels and an unacknowledged press invites a second one.
          const wallet = await findInjectedWallet(preference.rdns ?? '');
          if (!wallet) {
            setFailure({ message: WALLET_GONE, code: 'UNSUPPORTED' });
            return;
          }

          // Deliberately not `runLogin`: nothing is being signed and the session is untouched.
          // This only widens what the extension shares. If the user grants a different account,
          // the watcher reports it and the switched-account panel offers the sign-in.
          //
          // The answer matters here in a way it does not when connecting. A connect that could
          // not ask still gets an account from `eth_requestAccounts`; this is the whole
          // operation, so a swallowed failure would be a button that does nothing, forever,
          // with no way for the user to tell that from a wallet that simply had nothing to add.
          const asked = await requestAccountAccess(wallet.provider);
          if (!asked) setFailure({ message: CANNOT_REOFFER, code: 'UNSUPPORTED' });
        } catch (err) {
          const walletError = toWalletError(err);
          setFailure(
            walletError.code === 'CANCELLED'
              ? null
              : { message: walletError.message, code: walletError.code },
          );
        } finally {
          setBusy(false);
        }
      },
      async signOut() {
        await doLogout();
        // A message from a wallet flow must not survive into the anonymous panel, where it reads
        // as a reason the sign-in that has not been attempted yet already failed.
        setFailure(null);
        // Drop the remembered wallet too: the next person at this browser may be
        // a different one, and a stale preference would silently offer to
        // reconnect an account that is not theirs.
        forgetWallet();
        setUser(null);
        setWalletSession(false);
        setStatus('anonymous');
      },
    }),
    [status, user, error, errorCode, busy, walletAccount, walletSwitched, walletSession, runLogin],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
