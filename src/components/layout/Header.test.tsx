import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { Header } from './Header';

/**
 * What the masthead offers, and to whom.
 *
 * The Wallet is the whole subject here. Everything on that screen is derived from a key, so a
 * visitor holding none has nothing to open — and the link used to be there anyway, leading to a
 * screen whose only control was an unlock that could not succeed.
 */

const session = {
  status: 'anonymous' as string,
  user: null as { id: string; address: string; displayName: string | null } | null,
  error: null as string | null,
  errorCode: null as string | null,
  busy: false,
  walletAccount: null as string | null,
  walletSwitched: false,
  walletSession: false,
  signUpWithPasskey: vi.fn(async () => {}),
  signInWithPasskey: vi.fn(async () => {}),
  signInWithInjected: vi.fn(async () => {}),
  useSwitchedAccount: vi.fn(async () => {}),
  chooseAccount: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => session,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// No App Router in a unit test, so `usePathname` has no context to read and returns null — which
// the active-link check would then call `startsWith` on.
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const adminMe = vi.fn(async () => ({ isOperator: false }));
vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    admin: { me: (...args: unknown[]) => adminMe(...(args as [])) },
    // `PoolProvider` is real in the shared render tree and asks for this on mount.
    unlink: { environment: vi.fn(async () => ({ enabled: false })) },
  },
}));

function walletLink() {
  return screen.queryByRole('link', { name: 'Wallet' });
}

beforeEach(() => {
  session.status = 'anonymous';
  session.user = null;
  adminMe.mockClear().mockResolvedValue({ isOperator: false });
});

describe('Header — the Wallet tab', () => {
  it('offers the Wallet once an account is connected (positive)', async () => {
    session.status = 'authenticated';
    session.user = { id: 'u1', address: '0xabc', displayName: null };

    renderWithProviders(<Header />);

    expect(walletLink()).toHaveAttribute('href', '/wallet');
  });

  it('hides the Wallet from a visitor who has not signed in (REGRESSION)', () => {
    // A passkey or MetaMask session both land on `authenticated`; nothing else does. The tab used
    // to be permanent, and following it while anonymous reached a screen offering to unlock a
    // session that did not exist.
    renderWithProviders(<Header />);

    expect(walletLink()).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Markets' })).toBeInTheDocument();
  });

  it('shows nothing while the session is still being restored (negative)', () => {
    // A returning session arrives one request later. A tab that appears, vanishes and comes back
    // is worse than one that arrives a moment late.
    session.status = 'loading';

    renderWithProviders(<Header />);

    expect(walletLink()).not.toBeInTheDocument();
  });
});

describe('Header — operator nav', () => {
  it('adds Operations for a wallet that holds the role (positive)', async () => {
    session.status = 'authenticated';
    session.user = { id: 'u1', address: '0xabc', displayName: null };
    adminMe.mockResolvedValue({ isOperator: true });

    renderWithProviders(<Header />);

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Operations' })).toBeInTheDocument(),
    );
    // Alongside the Wallet, not instead of it.
    expect(walletLink()).toBeInTheDocument();
  });

  it('never asks about the role while anonymous (negative)', () => {
    renderWithProviders(<Header />);

    expect(adminMe).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Operations' })).not.toBeInTheDocument();
  });
});
