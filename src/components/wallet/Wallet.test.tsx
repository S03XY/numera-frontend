import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { parseAmount, Wallet } from './Wallet';
import { usePool } from '@/lib/pool/PoolProvider';

/** The EOA the user signed in with — the one that pays gas for the public steps. */
const SESSION_ADDRESS = '0x2f8B7a19cD40e35B916a72D8Ef05C34a19bE7d60';

const session = {
  status: 'authenticated' as string,
  user: { id: 'u1', address: SESSION_ADDRESS, displayName: null } as {
    id: string;
    address: string;
    displayName: string | null;
  } | null,
};

vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => session,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// `usePool` is stubbed so each test can drive the wallet's state directly, but
// `PoolProvider` must stay a real component: `renderWithProviders` mirrors the
// app's provider tree and renders it. A passthrough keeps the tree intact.
vi.mock('@/lib/pool/PoolProvider', () => ({
  usePool: vi.fn(),
  PoolProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// Partial: `evm.ts` also reads DEFAULT_CHAIN_ID from here, and replacing the
// whole module would break the chain definition it builds at import time.
vi.mock('@/lib/chain/collateral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chain/collateral')>()),
  COLLATERAL_ADDRESS: '0x2222222222222222222222222222222222222222',
}));
/** What the user's public address holds. Mutable, so a claim can be seen to change it. */
const publicHoldings = { collateral: 0n, native: 0n };

vi.mock('@/lib/wallet/collateral', async () => {
  const actual = await vi.importActual<typeof import('@/lib/wallet/collateral')>(
    '@/lib/wallet/collateral',
  );
  return {
    ...actual,
    // Public-chain reads, stubbed so the suite never touches an RPC.
    nativeBalance: vi.fn(async () => publicHoldings.native),
    publicBalance: vi.fn(async () => publicHoldings.collateral),
    faucetCooldown: vi.fn(async () => 0n),
    // Mints, the way the real one does — and only resolves once it has, which is the property the
    // refresh below depends on.
    claimTestTokens: vi.fn(async () => {
      publicHoldings.collateral += 100_000_000n;
      return '0xfaucet';
    }),
  };
});

/**
 * The shielded balance the wallet renders.
 *
 * Held in a mutable box rather than re-mocked per test, because the pool object identity is
 * memoised on the execution root and swapping the module export mid-test would not reach the one
 * the component already holds.
 */
const shieldedBalance = {
  total: 1_500_000n,
  spendable: 1_500_000n,
  pendingChange: 0n,
  syncing: false,
} as Record<string, unknown>;

vi.mock('@/lib/pool/useShieldedPool', () => ({
  useShieldedPool: () => ({
    balance: vi.fn(async () => shieldedBalance),
    held: vi.fn(async () => ({ total: 0n, operations: [] })),
    deposit: vi.fn(async () => undefined),
    withdraw: vi.fn(async () => undefined),
  }),
}));
// The faucet and deposit buttons re-acquire a signer through `reconnectWallet`,
// which must never be the passkey path directly — see `lib/wallet/reconnect.ts`.
vi.mock('@/lib/wallet/reconnect', () => ({ reconnectWallet: vi.fn() }));

const mockUseUnlink = usePool as unknown as ReturnType<typeof vi.fn>;
const unlock = vi.fn();

function state(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    reason: null,
    executionRoot: `0x${'ab'.repeat(32)}`,
    state: { enabled: true, synced: true, leaves: [] },
    unlock,
    lock: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  publicHoldings.collateral = 0n;
  publicHoldings.native = 0n;
  session.status = 'authenticated';
  session.user = { id: 'u1', address: SESSION_ADDRESS, displayName: null };
  mockUseUnlink.mockReturnValue(state());
});

describe('parseAmount', () => {
  it.each([
    ['1', 1_000_000n],
    ['0.5', 500_000n],
    ['12.34', 12_340_000n],
    ['0.000001', 1n],
    ['1000000', 1_000_000_000_000n],
    ['0', 0n],
    ['  2.5  ', 2_500_000n],
  ])('parses %p to %s base units (positive)', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['', '.', 'abc', '1.2.3', '-1', '1e6', '1,000'])(
    'rejects malformed input %p (negative)',
    (input) => {
      expect(parseAmount(input)).toBeNull();
    },
  );

  it('rejects more precision than the token has, rather than truncating (regression)', () => {
    // Silently dropping a digit would be a money bug.
    expect(parseAmount('1.1234567')).toBeNull();
    expect(parseAmount('1.123456')).toBe(1_123_456n);
  });

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseAmount('10000000000000')).toBe(10_000_000_000_000_000_000n);
  });
});

describe('Wallet — availability', () => {
  it('explains itself when no privacy layer exists (negative)', () => {
    mockUseUnlink.mockReturnValue(
      state({ status: 'unavailable', reason: 'Design preview has no privacy layer.', executionRoot: null }),
    );
    renderWithProviders(<Wallet />);

    expect(screen.getByText('Private trading is not available here')).toBeInTheDocument();
    expect(screen.getByText(/Design preview has no privacy layer/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
  });

  it('asks a visitor to sign in rather than to unlock (REGRESSION)', () => {
    // Reached by bookmark or a shared link — the masthead no longer offers the tab while
    // anonymous. Everything on this screen is derived from the signed-in key, so "Unlock private
    // trading" was an offer to unlock a session that did not exist.
    session.status = 'anonymous';
    session.user = null;
    mockUseUnlink.mockReturnValue(state({ status: 'locked', executionRoot: null }));

    renderWithProviders(<Wallet />);

    expect(screen.getByText('Sign in to open your wallet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
  });

  it('says neither while the session is still being restored (negative)', () => {
    session.status = 'loading';
    session.user = null;
    mockUseUnlink.mockReturnValue(state({ status: 'locked', executionRoot: null }));

    renderWithProviders(<Wallet />);

    expect(screen.queryByText('Sign in to open your wallet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
    // The heading stays, so the page is not blank while it waits.
    expect(screen.getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
  });

  it('offers to unlock when locked, and says the key never leaves the device', () => {
    mockUseUnlink.mockReturnValue(state({ status: 'locked', executionRoot: null }));
    renderWithProviders(<Wallet />);

    expect(screen.getByText(/never leaves this device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock private trading' })).toBeEnabled();
  });

  it('triggers the passkey flow on unlock (positive)', async () => {
    mockUseUnlink.mockReturnValue(state({ status: 'locked', executionRoot: null }));
    renderWithProviders(<Wallet />);

    await userEvent.click(screen.getByRole('button', { name: 'Unlock private trading' }));
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('disables the button and reports progress while unlocking', () => {
    mockUseUnlink.mockReturnValue(state({ status: 'unlocking', executionRoot: null }));
    renderWithProviders(<Wallet />);
    expect(screen.getByRole('button', { name: 'Unlocking…' })).toBeDisabled();
  });

  it('surfaces an unlock failure without losing the retry (negative)', () => {
    mockUseUnlink.mockReturnValue(
      state({ status: 'error', reason: 'Passkey unavailable', executionRoot: null }),
    );
    renderWithProviders(<Wallet />);

    expect(screen.getByText('Passkey unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock private trading' })).toBeEnabled();
  });
});

describe('Wallet — unlocked', () => {
  it('shows the shielded balance (positive)', async () => {
    renderWithProviders(<Wallet />);

    expect(await screen.findByText('$1.5')).toBeInTheDocument();
    expect(screen.getByText(/not visible on-chain/)).toBeInTheDocument();
  });

  it('shows no shielded address, because there is not one (REGRESSION)', async () => {
    /*
      The previous privacy layer issued every user an address and the wallet displayed it. This
      pool does not: a balance is a set of commitments in a shared tree that nobody can attribute,
      which is the stronger property. Inventing a handle to fill the gap would misrepresent it, and
      showing a stale one would be worse — so the panel explains the absence instead.
    */
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    expect(screen.queryByText(/shielded address/i)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing here to back up or lose/i)).toBeInTheDocument();
  });

  /**
   * The claim landed and the screen still said $0.
   *
   * Two independent causes, both worth pinning. The faucet used to resolve on *broadcast*, so the
   * refetch that follows it read the chain before the mint existed; and the invalidation named
   * `['unlink', 'balances']`, a key that stopped existing when the shielded pool replaced the
   * vendor — so nothing it targeted was ever refetched again, here or after a trade.
   */
  it('updates the public balance once a claim has landed (REGRESSION)', async () => {
    publicHoldings.collateral = 0n;
    // Gas, so the panel offers the button rather than the fund-me prompt.
    publicHoldings.native = 10n ** 18n;
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    const { reconnectWallet } = await import('@/lib/wallet/reconnect');
    (reconnectWallet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: SESSION_ADDRESS,
      kind: 'passkey',
      // `signerWalletClient` builds a client from this; without it the click fails before it ever
      // reaches the faucet, and the test would pass or fail for the wrong reason.
      evmAccount: { address: SESSION_ADDRESS, type: 'local' },
      signMessage: async () => '0x',
      disconnect: vi.fn(),
    });

    await userEvent.click(screen.getByRole('button', { name: /get test collateral/i }));

    await waitFor(() => expect(screen.getByText('$100')).toBeInTheDocument());
  });

  it('offers funding, withdrawal and recovery', async () => {
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    expect(screen.getByRole('heading', { name: 'Add funds' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('offers no way to restore a position list (REGRESSION)', async () => {
    // Accounts are derived from the passkey, so there is no list to lose and nothing to rebuild —
    // and with no cross-market portfolio there is no screen that would read one. The panel
    // restored into a registry nothing consumes, which is worse than absent: it implied the
    // positions were missing until you pressed it.
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    expect(screen.queryByRole('heading', { name: /restore positions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore my positions/i })).not.toBeInTheDocument();
  });

  it('warns against withdrawing to the depositing address (regression)', async () => {
    // The one way a user can accidentally undo their own privacy.
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');
    await userEvent.click(screen.getByRole('button', { name: /why the destination matters/i }));
    expect(screen.getByText(/undoes the privacy you paid for/)).toBeInTheDocument();
  });

  it('keeps deposit and withdraw disabled until the inputs are valid (negative)', async () => {
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    const deposit = screen.getByRole('button', { name: 'Deposit' });
    const withdraw = screen.getByRole('button', { name: 'Withdraw' });
    expect(deposit).toBeDisabled();
    expect(withdraw).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Deposit amount'), '5');
    expect(deposit).toBeEnabled();

    // Withdrawal still needs a destination.
    await userEvent.type(screen.getByLabelText('Withdrawal amount'), '5');
    expect(withdraw).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Destination address'), '0x1234');
    expect(withdraw).toBeEnabled();
  });

  it('rejects a zero amount (negative)', async () => {
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    await userEvent.type(screen.getByLabelText('Deposit amount'), '0');
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  });

  it('offers no unswept-funds scan (REGRESSION)', async () => {
    // The scan enumerated accounts by asking Unlink which slots it had allocated. Market accounts
    // are derived now and Unlink never allocated them, so it could only ever report "nothing
    // unswept" — including when a derived account was holding float. A recovery tool that cannot
    // see the accounts it is meant to recover from is worse than none: it answers the question
    // wrongly and confidently. Float is reclaimed from the market's own panel instead.
    renderWithProviders(<Wallet />);
    await screen.findByText('$1.5');

    expect(screen.queryByRole('heading', { name: /unswept funds/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scan for unswept/i })).not.toBeInTheDocument();
  });
});

describe('Wallet — public account', () => {
  it('shows the address that pays for gas (positive)', async () => {
    renderWithProviders(<Wallet />);
    await waitFor(() => expect(screen.getByText(/your public account/i)).toBeInTheDocument());
    expect(screen.getByText(SESSION_ADDRESS)).toBeInTheDocument();
  });

  it('names the missing prerequisite instead of failing later (regression)', async () => {
    // Without this, a first-time tester presses "Get test collateral", the
    // transaction fails for want of gas, and the UI never told them which
    // address to fund or where to get MON.
    renderWithProviders(<Wallet />);
    await waitFor(() => expect(screen.getByText(/holds no MON/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /monad testnet faucet/i })).toHaveAttribute(
      'href',
      'https://faucet.monad.xyz',
    );
  });

  it('hides the faucet prompt once the account has gas (negative)', async () => {
    const { nativeBalance } = await import('@/lib/wallet/collateral');
    (nativeBalance as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 18n);

    renderWithProviders(<Wallet />);
    await waitFor(() => expect(screen.getByText('1.0000 MON')).toBeInTheDocument());
    expect(screen.queryByText(/holds no MON/i)).not.toBeInTheDocument();
  });

  it('states that nothing after the deposit is linked to it (PRIVACY)', async () => {
    // Behind the ⓘ now, but the claim itself must survive any edit that trims prose.
    renderWithProviders(<Wallet />);
    await userEvent.click(
      await screen.findByRole('button', { name: /what the public account is for/i }),
    );
    expect(screen.getByText(/nothing after that is linked to it/i)).toBeInTheDocument();
  });
});

describe('Wallet — balance while Engine is catching up', () => {
  async function withBalance(balance: Record<string, unknown>) {
    Object.assign(shieldedBalance, balance);
  }

  it('never presents a syncing figure as final (REGRESSION — looked like lost funds)', async () => {
    // Engine deliberately under-reports while it settles a spend, so a healthy
    // account can read zero right after a trade. Rendering that bare is how a
    // routine $5 bet looked like $500 vanishing.
    await withBalance({ total: 0n, spendable: 0n, pendingChange: 0n, syncing: true });
    renderWithProviders(<Wallet />);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/still settling|nothing is lost/i),
    );
  });

  it('stays quiet once the balance has settled (negative)', async () => {
    await withBalance({
      total: 600_000_000n,
      spendable: 600_000_000n,
      pendingChange: 0n,
      syncing: false,
    });
    renderWithProviders(<Wallet />);

    await screen.findByText('$600');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says how much is actually spendable when change is in flight (positive)', async () => {
    // A total that silently rejects the next trade is its own kind of lie.
    await withBalance({
      total: 600_000_000n,
      spendable: 100_000_000n,
      pendingChange: 500_000_000n,
      syncing: false,
    });
    renderWithProviders(<Wallet />);

    await waitFor(() =>
      expect(screen.getByText(/available to trade now/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/\$100 is/)).toBeInTheDocument();
  });
});
