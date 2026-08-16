'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '@/lib/api/endpoints';
import type { PoolState } from '@/lib/api/types';
import { useSession } from '@/lib/auth/useSession';
import { reconnectWallet } from '@/lib/wallet/reconnect';
import { toWalletError, type WalletSigner } from '@/lib/wallet/types';
import { deriveExecutionRoot, type ExecutionRoot } from '@/lib/execution/keys';
import { POOL_CONFIG } from './config';

/**
 * Session-scoped access to the shielded pool.
 *
 * Replaces `UnlinkProvider`, and keeps its shape on purpose: the same five states, the same
 * `unlock`/`lock` pair, the same rule that a refusal is a state with a sentence attached. Six
 * components render off this and none of them had to change.
 *
 * What is *gone* is everything that made the old one fragile. No vendor SDK, no session manager, no
 * registration round trip, no authorization token, no environment handshake that could fail and
 * leave the panel offering an unlock into nothing. Unlocking is now one signature and some
 * arithmetic: derive the root, derive the master keys, done. It cannot fail for a reason outside
 * this repository.
 *
 * ## Why it is locked at all
 *
 * The root secret derives every note and every market account. It lives in React state and nowhere
 * else — never localStorage, never sessionStorage, never the query cache, which some devtools
 * serialise. Signing out drops it, and so does switching wallet accounts.
 *
 * One signature, taken once per session, because the login flow deliberately zeroes the Mera
 * signing session as soon as SIWE completes: the key genuinely is not sitting in memory waiting to
 * be reused.
 */

export type PoolStatus =
  /** No privacy layer here: disabled or misconfigured in this build. */
  | 'unavailable'
  /** Available, but the user has not unlocked it this session. */
  | 'locked'
  | 'unlocking'
  | 'ready'
  | 'error';

interface PoolContextValue {
  status: PoolStatus;
  /** Why the layer is unavailable, or why unlocking failed. Renderable copy. */
  reason: string | null;
  /**
   * The secret every note and every market account is derived from. Never leaves the browser.
   *
   * `null` until unlocked, which is a normal state rather than an error: callers offer the passkey
   * instead of reporting a fault.
   */
  executionRoot: ExecutionRoot | null;
  /** The pool's public state, or undefined while it is being read. */
  state: PoolState | undefined;
  /** Prompt for the signature and derive the root. */
  unlock: (signer?: WalletSigner) => Promise<void>;
  /** Drop the in-memory root. Called on sign-out and on a change of account. */
  lock: () => void;
}

const PoolContext = React.createContext<PoolContextValue | null>(null);

type SessionState =
  | { kind: 'locked' }
  | { kind: 'unlocking' }
  | { kind: 'ready'; executionRoot: ExecutionRoot }
  | { kind: 'error'; reason: string };

/**
 * Said when `/api/pool/state` will not answer.
 *
 * Phrased as a wait because that is what it usually is — the read retries by itself and the panel
 * recovers without a reload — and it names the layer rather than the request, because "500 from the
 * state endpoint" is not a fact anybody outside this repo can act on.
 */
const POOL_UNREACHABLE =
  'The privacy layer is not answering, so private trading cannot be unlocked right now. ' +
  'Nothing is wrong with your account or your balance. This page keeps checking and will ' +
  'recover on its own.';

export function PoolProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<SessionState>({ kind: 'locked' });
  // Mounted inside `SessionProvider`, so this is the address the signed-in session was built on —
  // the one every derivation below has to come from.
  const { user } = useSession();
  const signedIn = user?.address ?? null;

  const { data: state, isError: stateFailed } = useQuery({
    queryKey: ['pool', 'state'],
    queryFn: ({ signal }) => endpoints.pool.state(signal),
    /*
      Short, because this is not a static fact about the deployment — it is the state tree, and it
      grows with every deposit anybody makes. A stale copy produces a proof against a root the chain
      has moved past, which fails half a minute later with a revert naming the root.

      Refetched on an interval for the same reason: a trader who leaves the tab open and comes back
      should prove against the tree as it is now, not as it was when they arrived.
    */
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
    retryDelay: 500,
  });

  /**
   * Is a privacy layer usable here at all?
   *
   * Computed during render rather than mirrored into state by an effect — an effect would render
   * once with the wrong answer and then correct itself, which React 19 rightly flags.
   */
  const availability = ((): { available: true } | { available: false; reason: string } => {
    if (!POOL_CONFIG.enabled) return { available: false, reason: POOL_CONFIG.reason };
    /*
      The state read failed, so we do not know what is out there.

      Reported unavailable rather than locked because it is the honest answer: nothing can be
      unlocked into a privacy layer we cannot reach. The version of this that treated "not asked
      yet" and "asked and failed" as the same thing produced the worst outcome available — the panel
      offered "Unlock private trading" and the button did nothing at all, with no prompt, no spinner
      and no message.
    */
    if (stateFailed) return { available: false, reason: POOL_UNREACHABLE };
    if (state && !state.enabled) {
      return { available: false, reason: 'This deployment has no privacy layer configured.' };
    }
    return { available: true };
  })();

  // An unlocked session outranks availability: once the root exists it keeps working even if the
  // state query later resettles.
  const unavailable = !availability.available && session.kind !== 'ready';

  const status: PoolStatus = unavailable ? 'unavailable' : session.kind;
  const reason = unavailable
    ? (availability as { reason: string }).reason
    : session.kind === 'error'
      ? session.reason
      : null;
  const executionRoot = session.kind === 'ready' ? session.executionRoot : null;

  const unlock = React.useCallback(
    async (injectedSigner?: WalletSigner) => {
      // Every refusal says something. A primary button that does nothing at all is
      // indistinguishable from a broken build, and was once reported as one.
      if (!POOL_CONFIG.enabled) {
        setSession({ kind: 'error', reason: POOL_CONFIG.reason });
        return;
      }

      setSession({ kind: 'unlocking' });

      // Short-lived on purpose: the signer exists only to produce the one derivation signature,
      // then its key material is zeroed.
      let signer: WalletSigner | null = null;
      try {
        /*
          `reconnectWallet`, never `connectPasskeyWallet`, and always with the signed-in address.

          Prompting a MetaMask user for a passkey would derive a different — perfectly valid, and
          therefore silently wrong — set of notes, showing them an empty balance that is nobody's
          bug. Matching the extension was never enough either: MetaMask switched to its second
          account hands back a different key. This is the single most important place that argument
          is supplied, because this is the call that derives everything.
        */
        signer = injectedSigner ?? (await reconnectWallet(signedIn));

        const root = await deriveExecutionRoot({
          signer,
          appId: 'numera',
          chainId: POOL_CONFIG.chainId,
        });

        setSession({ kind: 'ready', executionRoot: root });
      } catch (err) {
        const walletError = toWalletError(err);
        // Dismissing the passkey prompt is a decision, not a failure.
        setSession(
          walletError.code === 'CANCELLED'
            ? { kind: 'locked' }
            : { kind: 'error', reason: walletError.message },
        );
      } finally {
        // Only dispose signers we created; an injected one belongs to the caller.
        if (!injectedSigner) signer?.disconnect?.();
      }
    },
    [signedIn],
  );

  const lock = React.useCallback(() => setSession({ kind: 'locked' }), []);

  /*
    One shielded session per signed-in key, enforced rather than assumed.

    Keyed on the address rather than on a sign-out handler, because the address is what actually has
    to match. The root derives every note and every market account, so carrying it across a change
    of key would show the new session the previous one's balance and sign with its addresses.

    Adjusted during render, not in an effect. React sanctions this exact shape for resetting state
    when something it derives from changes, and it is the honest one here: an effect would commit
    one frame in which the previous key's root is still live and still readable through this
    context. The re-render happens before anything is painted.
  */
  const [sessionOwner, setSessionOwner] = React.useState<string | null>(signedIn);
  if (sessionOwner !== signedIn) {
    setSessionOwner(signedIn);
    setSession({ kind: 'locked' });
  }

  const value = React.useMemo<PoolContextValue>(
    () => ({ status, reason, executionRoot, state, unlock, lock }),
    [status, reason, executionRoot, state, unlock, lock],
  );

  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>;
}

export function usePool(): PoolContextValue {
  const ctx = React.useContext(PoolContext);
  if (!ctx) throw new Error('usePool must be used within a PoolProvider');
  return ctx;
}
