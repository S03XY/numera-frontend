import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectButton } from './ConnectButton';
import { renderWithProviders } from '@/test/render';
import type { InjectedWallet } from '@/lib/wallet/injected';

const session = {
  status: 'anonymous' as string,
  user: null as { id: string; address: string; displayName: string | null } | null,
  error: null as string | null,
  errorCode: null as string | null,
  busy: false,
  signUpWithPasskey: vi.fn(async (_store?: string) => {}),
  signInWithPasskey: vi.fn(async () => {}),
  signInWithInjected: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => session,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const discovery = {
  wallets: [] as InjectedWallet[],
  searching: false,
};

vi.mock('@/lib/wallet/useInjectedWallets', () => ({
  useInjectedWallets: () => discovery,
}));

/** What the browser answers about its own PRF support. `null` is "cannot tell". */
const prfCapability = vi.fn(async (): Promise<boolean | null> => null);
vi.mock('@/lib/wallet/mera', () => ({ prfCapability: () => prfCapability() }));

const ADDRESS = '0x2f8B7a19cD40e35B916a72D8Ef05C34a19bE7d60';

const metamask: InjectedWallet = {
  rdns: 'io.metamask',
  name: 'MetaMask',
  icon: 'data:image/svg+xml,<svg/>',
  provider: { request: vi.fn() },
};

/** Open the panel. It now lands on the fork between the two account types. */
async function openPanel() {
  renderWithProviders(<ConnectButton />);
  await userEvent.click(screen.getByRole('button', { name: /enter/i }));
}

beforeEach(() => {
  session.status = 'anonymous';
  session.user = null;
  session.error = null;
  session.errorCode = null;
  session.busy = false;
  // Reassigned rather than cleared, because the recovery tests below swap in implementations that
  // reject. `clearAllMocks` keeps those, and a leaked rejection fails an unrelated test later.
  session.signUpWithPasskey = vi.fn(async (_store?: string) => {});
  session.signInWithPasskey = vi.fn(async () => {});
  prfCapability.mockResolvedValue(null);
  discovery.wallets = [];
  discovery.searching = false;
  vi.clearAllMocks();
});

describe('ConnectButton — choosing an account type', () => {
  it('invites the user in (positive)', () => {
    renderWithProviders(<ConnectButton />);
    expect(screen.getByRole('button', { name: /enter/i })).toBeInTheDocument();
  });

  it('offers passkey and external wallet as equal choices (positive)', async () => {
    await openPanel();
    expect(screen.getByRole('button', { name: /use a passkey/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use metamask/i })).toBeInTheDocument();
  });

  it('states that neither key is linked to a bet (PRIVACY)', async () => {
    await openPanel();
    expect(screen.getByText(/never attached to a bet/i)).toBeInTheDocument();
  });

  it('does not sign anything just by opening the panel (regression)', async () => {
    // The fork must be inert. Prompting for a passkey on open would be a
    // ceremony the user never asked for, and would pick their account type
    // for them.
    await openPanel();
    expect(session.signUpWithPasskey).not.toHaveBeenCalled();
    expect(session.signInWithPasskey).not.toHaveBeenCalled();
    expect(session.signInWithInjected).not.toHaveBeenCalled();
  });

  it('closes on Escape rather than trapping the user (negative)', async () => {
    await openPanel();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /use a passkey/i })).not.toBeInTheDocument();
  });
});

describe('ConnectButton — passkey branch', () => {
  async function openPasskey() {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));
  }

  it('offers both signup and returning sign-in (positive)', async () => {
    await openPasskey();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /already have one/i })).toBeInTheDocument();
  });

  it('states what signing does and does not reveal (PRIVACY)', async () => {
    await openPasskey();
    expect(screen.getByText(/reveals nothing about what you trade/i)).toBeInTheDocument();
  });

  it('runs signup and closes the panel (positive)', async () => {
    await openPasskey();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(session.signUpWithPasskey).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
  });

  it('runs returning sign-in (positive)', async () => {
    await openPasskey();
    await userEvent.click(screen.getByRole('button', { name: /already have one/i }));
    expect(session.signInWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('lets the user back out to the other option (regression)', async () => {
    // Someone who clicks "passkey" and then realises they have MetaMask must
    // not have to close and reopen the panel to change their mind.
    await openPasskey();
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('button', { name: /use metamask/i })).toBeInTheDocument();
  });

  it('disables the actions while a ceremony is in flight (negative)', async () => {
    session.busy = true;
    await openPasskey();
    expect(screen.getByRole('button', { name: /waiting/i })).toBeDisabled();
  });

  it('surfaces a wallet error inside the panel (negative)', async () => {
    session.error = 'Passkeys are not supported in this browser.';
    await openPasskey();
    expect(screen.getByRole('alert')).toHaveTextContent(/not supported/i);
  });
});

describe('ConnectButton — external wallet branch', () => {
  async function openWallets() {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use metamask/i }));
  }

  it('lists the wallet that announced itself (positive)', async () => {
    discovery.wallets = [metamask];
    await openWallets();

    expect(screen.getByRole('button', { name: /metamask/i })).toBeInTheDocument();
  });

  it('signs in with the announced provider, not window.ethereum (regression)', async () => {
    // The point of EIP-6963, and it still holds with one supported wallet: whichever extension
    // won the race for `window.ethereum` may not be MetaMask, so the provider we connect has to
    // be the one that came with the announcement rather than the global.
    discovery.wallets = [metamask];
    await openWallets();
    await userEvent.click(screen.getByRole('button', { name: /metamask/i }));

    expect(session.signInWithInjected).toHaveBeenCalledWith(metamask);
  });

  it('closes the panel after connecting (positive)', async () => {
    discovery.wallets = [metamask];
    await openWallets();
    await userEvent.click(screen.getByRole('button', { name: /metamask/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /metamask/i })).not.toBeInTheDocument(),
    );
  });

  it('says it is still looking before declaring none installed (negative)', async () => {
    // Extensions answer asynchronously. Telling someone with MetaMask that they
    // have no wallet is the worst outcome available here.
    discovery.wallets = [];
    discovery.searching = true;
    await openWallets();

    expect(screen.getByText(/looking for metamask/i)).toBeInTheDocument();
    expect(screen.queryByText(/metamask was not found/i)).not.toBeInTheDocument();
  });

  it('offers the passkey as a way out when no wallet exists (negative)', async () => {
    discovery.wallets = [];
    discovery.searching = false;
    await openWallets();

    expect(screen.getByText(/metamask was not found/i)).toBeInTheDocument();
    expect(screen.getByText(/use a passkey instead/i)).toBeInTheDocument();
  });

  it('warns that contract wallets cannot derive a shielded balance (negative)', async () => {
    discovery.wallets = [metamask];
    await openWallets();
    expect(screen.getByText(/smart-contract wallets cannot derive/i)).toBeInTheDocument();
  });

  it('promises the signature costs nothing (PRIVACY)', async () => {
    discovery.wallets = [metamask];
    await openWallets();
    expect(screen.getByText(/costs no gas and moves no funds/i)).toBeInTheDocument();
  });

  it('blocks a second click while one connection is in flight (negative)', async () => {
    session.busy = true;
    discovery.wallets = [metamask];
    await openWallets();
    expect(screen.getByRole('button', { name: /metamask/i })).toBeDisabled();
  });
});

describe('ConnectButton — authenticated', () => {
  beforeEach(() => {
    session.status = 'authenticated';
    session.user = { id: 'u1', address: ADDRESS, displayName: null };
  });

  it('shows the truncated key, never a name or email (PRIVACY)', () => {
    renderWithProviders(<ConnectButton />);
    expect(screen.getByRole('button', { name: /0x2f8B…7d60/i })).toBeInTheDocument();
  });

  it('explains that the login key is never attached to a bet (PRIVACY)', async () => {
    renderWithProviders(<ConnectButton />);
    await userEvent.click(screen.getByRole('button', { name: /0x2f8B…7d60/i }));
    expect(screen.getByText(/never attached to a bet/i)).toBeInTheDocument();
  });

  it('signs out', async () => {
    renderWithProviders(<ConnectButton />);
    await userEvent.click(screen.getByRole('button', { name: /0x2f8B…7d60/i }));
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(session.signOut).toHaveBeenCalledTimes(1);
  });
});

/*
  The way out of a passkey store that cannot derive keys.

  Which provider a browser hands a passkey to is its own decision, and no website can ask for a
  different one. It can ask to leave the machine, though, and a phone or a security key derives
  keys where a browser profile cannot. Before this the message was the end of the road: accurate,
  and still a dead end with nothing left to press.
*/
describe('ConnectButton — recovering from a passkey that cannot derive a key', () => {
  /** Fail the way the real ceremony fails, so `run` leaves the panel open. */
  async function failCreating(code: string) {
    session.error = 'We asked twice and got no account key back.';
    session.errorCode = code;
    session.signUpWithPasskey = vi.fn(async () => {
      throw new Error('no key');
    });
    session.signInWithPasskey = vi.fn(async () => {
      throw new Error('no key');
    });
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));
  }

  it('offers exactly two ways in and no third (REGRESSION)', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));

    // Create, or sign in. A separate button for saving somewhere else was tried here and is
    // deliberately gone: where a passkey is saved is chosen in the browser's own dialog, not in
    // this panel, so it belongs in the sentence below rather than as a third choice competing
    // with the two that are actually different intentions.
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /i already have one/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /phone or security key/i })).not.toBeInTheDocument();
  });

  it('says where to save it instead, when the store cannot derive (positive)', async () => {
    await failCreating('PRF_UNAVAILABLE');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/derives keys where that store cannot/i)).toBeInTheDocument();
  });

  it('stays quiet for a failure a different authenticator cannot fix (negative)', async () => {
    await failCreating('DERIVATION_FAILED');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/derives keys where that store cannot/i)).not.toBeInTheDocument();
  });

  it('warns that the device may ask twice (positive)', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));

    // Stores that evaluate PRF only when unlocking produce two prompts seconds apart. Unexplained,
    // the second one reads as a stuck screen and gets dismissed, which fails the signup.
    expect(screen.getByText(/may ask twice/i)).toBeInTheDocument();
  });
});

/*
  Asking the browser before letting anyone start.

  A store without PRF creates the credential happily and only fails when key material is asked
  for, leaving somebody holding a passkey that can never sign in and lives in their password
  manager forever. This is the one failure a website can see coming.

  It is narrow on purpose. `getClientCapabilities()` describes the BROWSER, never the store, so it
  catches a browser with no PRF completely and says nothing about a password manager that cannot
  derive keys, which the ceremony still has to discover.
*/
describe('ConnectButton — a browser that cannot derive keys', () => {
  async function openPasskeyStep() {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));
  }

  it('refuses to start and says why (positive)', async () => {
    prfCapability.mockResolvedValue(false);
    await openPasskeyStep();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot derive an account key/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/MetaMask/i);
  });

  it('holds signing in too (regression)', async () => {
    prfCapability.mockResolvedValue(false);
    await openPasskeyStep();

    // Signing in derives the account key from the same PRF output, so a browser that cannot
    // produce one cannot open an existing account either. Left live, it buys a ceremony that
    // fails at the end of it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /i already have one/i })).toBeDisabled(),
    );
  });

  it('never starts a ceremony that cannot finish (MONEY REGRESSION)', async () => {
    prfCapability.mockResolvedValue(false);
    await openPasskeyStep();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled(),
    );

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // The credential would be created before the failure and stay in the password manager for
    // good, offered on every later sign in and failing every time.
    expect(session.signUpWithPasskey).not.toHaveBeenCalled();
  });

  it('lets everyone through when the browser cannot tell (MONEY REGRESSION)', async () => {
    // Most browsers do not implement `getClientCapabilities` at all, and passkeys work fine in
    // them. Reading "cannot tell" as "no" would lock out nearly every visitor to spare a few a
    // wasted credential, which is a far larger failure than the one being prevented.
    prfCapability.mockResolvedValue(null);
    await openPasskeyStep();

    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays out of the way when the browser says yes (positive)', async () => {
    prfCapability.mockResolvedValue(true);
    await openPasskeyStep();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/may ask twice/i)).toBeInTheDocument();
  });

  it('drops the advice about where to save it (regression)', async () => {
    prfCapability.mockResolvedValue(false);
    await openPasskeyStep();

    // "Choose iCloud Keychain when asked" is guidance for a dialog that is never going to open
    // here, and it competes with the one sentence that matters.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/asks where to save it/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/may ask twice/i)).not.toBeInTheDocument();
  });
});

describe('ConnectButton — loading', () => {
  it('reserves the space without flashing a wrong state (regression)', () => {
    session.status = 'loading';
    renderWithProviders(<ConnectButton />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
