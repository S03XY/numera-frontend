import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The two wallet gestures, and which of them may open MetaMask's account picker.
 *
 * This distinction is the whole of the account-switch fix and it had no coverage at all, because
 * this file had no test file. Getting it backwards is silent in both directions: too eager and a
 * dialog opens while somebody is unlocking, where the account they pick seeds their shielded
 * identity; too shy and the bug returns, with a page that cannot see the account the user is
 * looking at.
 */

const SIGNED_IN = '0x1111111111111111111111111111111111111111';
const SWITCHED = '0x2222222222222222222222222222222222222222';
const THIRD = '0x3333333333333333333333333333333333333333';

const METAMASK = { rdns: 'io.metamask', name: 'MetaMask', icon: '', provider: { request: vi.fn() } };

type Options = { chooseAccount?: boolean } | undefined;

const connectInjectedWallet = vi.fn(async (_wallet: unknown, _options?: Options) => ({
  address: SIGNED_IN,
  kind: 'injected' as const,
  signMessage: async () => '0x',
}));
/** Resolves true when the wallet actually opened its picker. See `requestAccountAccess`. */
const requestAccountAccess = vi.fn(async (_provider: unknown) => true);
const findInjectedWallet = vi.fn(async (_rdns: string) => METAMASK as typeof METAMASK | null);

vi.mock('@/lib/wallet/injected', () => ({
  connectInjectedWallet: (wallet: unknown, options?: Options) =>
    connectInjectedWallet(wallet, options),
  requestAccountAccess: (provider: unknown) => requestAccountAccess(provider),
  findInjectedWallet: (rdns: string) => findInjectedWallet(rdns),
}));

const createPasskeyWallet = vi.fn(async (_label?: string, _store?: string) => ({
  address: SIGNED_IN,
  kind: 'passkey' as const,
  signMessage: async () => '0x',
}));
vi.mock('@/lib/wallet/mera', () => ({
  connectPasskeyWallet: vi.fn(async () => ({ address: SIGNED_IN, kind: 'passkey' as const })),
  createPasskeyWallet: (label?: string, store?: string) => createPasskeyWallet(label, store),
}));

const loginWithSigner = vi.fn(async () => ({
  user: { id: 'u1', address: SIGNED_IN, displayName: null },
}));
vi.mock('./login', () => ({
  loginWithSigner: (...args: unknown[]) => loginWithSigner(...(args as [])),
  logout: vi.fn(async () => undefined),
}));

vi.mock('@/lib/api/token-store', () => ({ tokenStore: { getRefresh: () => null, clear: vi.fn() } }));
vi.mock('@/lib/api/endpoints', () => ({ endpoints: { users: { me: vi.fn() } } }));

/** The watcher is the only way `walletAccount` moves, so the test drives it directly. */
let report: ((address: string | null) => void) | null = null;
vi.mock('@/lib/wallet/watch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/wallet/watch')>('@/lib/wallet/watch');
  return {
    sameAddress: actual.sameAddress,
    watchWalletAccount: (onChange: (address: string | null) => void) => {
      report = onChange;
      return () => {
        report = null;
      };
    },
  };
});

const { SessionProvider, useSession } = await import('./useSession');

function Probe() {
  const s = useSession();
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="user">{s.user?.address ?? ''}</span>
      <span data-testid="wallet">{s.walletAccount ?? ''}</span>
      <span data-testid="switched">{String(s.walletSwitched)}</span>
      <span data-testid="walletSession">{String(s.walletSession)}</span>
      <span data-testid="error">{s.error ?? ''}</span>
      <span data-testid="errorCode">{s.errorCode ?? ''}</span>
      {/* Swallowed the way `ConnectButton.run` swallows: these reject to tell the caller not to
          close the panel, and the message is already on `error`. An unhandled rejection here
          would fail the run for a path the real component handles. */}
      <button onClick={() => void s.signInWithInjected(METAMASK).catch(() => {})}>Sign in</button>
      <button onClick={() => void s.signUpWithPasskey().catch(() => {})}>Create</button>
      <button onClick={() => void s.signUpWithPasskey('cross-device').catch(() => {})}>
        Create elsewhere
      </button>
      <button onClick={() => void s.useSwitchedAccount().catch(() => {})}>Adopt</button>
      <button onClick={() => void s.chooseAccount().catch(() => {})}>Choose</button>
    </div>
  );
}

/** The options `connectInjectedWallet` was called with on call `n`. */
function optionsOf(call = 0): Options {
  return connectInjectedWallet.mock.calls[call]?.[1];
}

async function signIn() {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  report = null;
  connectInjectedWallet.mockResolvedValue({
    address: SIGNED_IN,
    kind: 'injected' as const,
    signMessage: async () => '0x',
  });
  loginWithSigner.mockResolvedValue({ user: { id: 'u1', address: SIGNED_IN, displayName: null } });
  requestAccountAccess.mockResolvedValue(true);
  findInjectedWallet.mockResolvedValue(METAMASK);
  createPasskeyWallet.mockResolvedValue({
    address: SIGNED_IN,
    kind: 'passkey' as const,
    signMessage: async () => '0x',
  });
});

describe('creating a passkey account', () => {
  it('leaves the store to the browser by default (positive)', async () => {
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createPasskeyWallet).toHaveBeenCalled());
    expect(createPasskeyWallet.mock.calls[0][1]).toBeUndefined();
  });

  it('forwards the retry that leaves this machine (REGRESSION)', async () => {
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await userEvent.click(screen.getByRole('button', { name: 'Create elsewhere' }));

    // Dropped here, the recovery button would silently repeat the ceremony that just failed, on
    // the same store, and report the same error. It would look like the fix was tried.
    await waitFor(() => expect(createPasskeyWallet).toHaveBeenCalled());
    expect(createPasskeyWallet.mock.calls[0][1]).toBe('cross-device');
  });

  it('publishes the code alongside the message (REGRESSION)', async () => {
    const { WalletError } = await import('@/lib/wallet/types');
    createPasskeyWallet.mockRejectedValueOnce(
      new WalletError('PRF_UNAVAILABLE', 'We asked twice and got no account key back.'),
    );

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The panel decides whether to offer a different authenticator from this, and there is no way
    // to ask by reading the sentence. Matching on message text would break on any copy edit.
    await waitFor(() =>
      expect(screen.getByTestId('errorCode')).toHaveTextContent('PRF_UNAVAILABLE'),
    );
  });

  it('carries no code once the failure clears (regression)', async () => {
    const { WalletError } = await import('@/lib/wallet/types');
    createPasskeyWallet.mockRejectedValueOnce(new WalletError('PRF_UNAVAILABLE', 'no key'));

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('errorCode')).toHaveTextContent('PRF_UNAVAILABLE'));

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // A stale code outlives its message and leaves the panel offering a retry for a failure that
    // already went away. Held as one field with the message so the two cannot drift.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('errorCode')).toHaveTextContent('');
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });
});

describe('signing in with a wallet', () => {
  it('opens the account picker (positive)', async () => {
    await signIn();

    // Without this the site is stuck on whichever account MetaMask granted first: it answers
    // `eth_requestAccounts` from the stored permission and never asks again, so an account the
    // user switched to is invisible until they connect it inside the extension by hand.
    expect(optionsOf()?.chooseAccount).toBe(true);
  });

  it('sets the option here rather than taking it from the caller (regression)', async () => {
    await signIn();

    // `ConnectButton` still calls `signInWithInjected(wallet)` with one argument. Threading the
    // option down from the component would let a second caller of this method quietly connect
    // without asking, and would turn the button's own test into a false pass.
    expect(connectInjectedWallet).toHaveBeenCalledTimes(1);
    expect(optionsOf()?.chooseAccount).toBe(true);
  });
});

describe('adopting the account the wallet switched to', () => {
  it('opens no picker, because the account is already named (regression)', async () => {
    await signIn();
    act(() => report?.(SWITCHED));
    await waitFor(() => expect(screen.getByTestId('switched')).toHaveTextContent('true'));

    connectInjectedWallet.mockResolvedValue({
      address: SWITCHED,
      kind: 'injected' as const,
      signMessage: async () => '0x',
    });
    loginWithSigner.mockResolvedValue({ user: { id: 'u2', address: SWITCHED, displayName: null } });

    await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent(SWITCHED));

    // The user pressed "Continue as 0x2222". Reopening the picker asks a question they have just
    // answered, and the grant would fire `accountsChanged` mid flight and relabel the very button
    // under their finger.
    expect(optionsOf(1)?.chooseAccount).toBeFalsy();
  });

  it('refuses a third account nobody named (MONEY REGRESSION)', async () => {
    await signIn();
    act(() => report?.(SWITCHED));
    await waitFor(() => expect(screen.getByTestId('switched')).toHaveTextContent('true'));

    // The wallet moved again between the render and the press.
    connectInjectedWallet.mockResolvedValue({
      address: THIRD,
      kind: 'injected' as const,
      signMessage: async () => '0x',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    // Signing in as an account neither offered nor chosen would open a third private balance,
    // silently, leaving both the one they were in and the one they asked for off screen.
    await waitFor(() => expect(screen.getByTestId('error')).not.toHaveTextContent(''));
    expect(loginWithSigner).toHaveBeenCalledTimes(1); // the original sign-in, and nothing since
    expect(screen.getByTestId('user')).toHaveTextContent(SIGNED_IN);
  });
});

describe('choosing a different account while signed in', () => {
  it('asks the wallet to re-offer its accounts (positive)', async () => {
    await signIn();

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));

    await waitFor(() => expect(requestAccountAccess).toHaveBeenCalledWith(METAMASK.provider));
  });

  it('signs nothing and leaves the session alone (regression)', async () => {
    await signIn();
    loginWithSigner.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(requestAccountAccess).toHaveBeenCalled());

    // This only widens what the extension shares. Whatever is granted arrives as an
    // `accountsChanged`, and the switched-account panel turns that into an offer. Signing in here
    // would take the decision away from the person making it.
    expect(loginWithSigner).not.toHaveBeenCalled();
    expect(screen.getByTestId('user')).toHaveTextContent(SIGNED_IN);
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('treats a dismissed picker as a decision, not an error (negative)', async () => {
    await signIn();
    const { WalletError } = await import('@/lib/wallet/types');
    requestAccountAccess.mockRejectedValueOnce(new WalletError('CANCELLED', 'Request cancelled.'));

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));

    await waitFor(() => expect(requestAccountAccess).toHaveBeenCalled());
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('says so when the wallet cannot reopen its own account list (negative)', async () => {
    await signIn();
    // A wallet that does not implement the permission request. Connecting tolerates that, because
    // it falls through and gets an account anyway. This is the whole operation, so swallowing the
    // failure would leave a button that does nothing and explains nothing.
    requestAccountAccess.mockResolvedValueOnce(false);

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(/open the extension/i));
  });

  it('says so when the extension has stopped answering (negative)', async () => {
    await signIn();
    findInjectedWallet.mockResolvedValueOnce(null);

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));

    // A locked or disabled extension. Returning quietly here was a press that produced nothing at
    // all, which is indistinguishable from a broken button.
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(/did not answer/i));
  });

  it('is offered to a wallet session even when no account is readable (MONEY REGRESSION)', async () => {
    await signIn();
    // The user disconnects this site inside MetaMask. `accountsChanged` fires with an empty array
    // and the watcher reports null. Reopening the picker is now the ONLY way back, so gating the
    // offer on an address would hide it exactly when it is needed.
    act(() => report?.(null));

    await waitFor(() => expect(screen.getByTestId('wallet')).toHaveTextContent(''));
    expect(screen.getByTestId('walletSession')).toHaveTextContent('true');
  });

  it('reuses the announced provider rather than rediscovering (regression)', async () => {
    await signIn();
    findInjectedWallet.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(requestAccountAccess).toHaveBeenCalled());

    // One discovery, not two. `findInjectedWallet` waits a fixed 300ms and re-dispatches the
    // EIP-6963 request, so stacking calls adds latency to a gesture that should feel immediate.
    expect(findInjectedWallet).toHaveBeenCalledTimes(1);
  });
});
