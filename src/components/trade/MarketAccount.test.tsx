import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarketAccount } from './MarketAccount';
import { renderWithProviders, makeMarket, makeOutcome } from '@/test/render';

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    positions: { forAccounts: vi.fn(async () => [] as unknown[]) },
    unlink: { environment: vi.fn(async () => ({ enabled: false })) },
  },
}));

// Who is signed in decides whether the locked panel offers an unlock or names the step before it.
const session = { status: 'authenticated' as string, user: { id: 'u1', address: '0xabc' } };
vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => session,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const unlinkMock = {
  status: 'ready' as string,
  client: {} as unknown,
  // Market accounts are derived from this, so a session with a root always has an address.
  executionRoot: ('0x' + '11'.repeat(32)) as `0x${string}`,
  state: { enabled: true, synced: true, leaves: [] } as unknown,
  reason: null as string | null,
  unlock: vi.fn(),
};
vi.mock('@/lib/pool/PoolProvider', () => ({
  usePool: () => unlinkMock,
  PoolProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Params are declared so `mock.calls[0][0]` is typed, not an empty tuple.
const fundingMock = {
  deposit: vi.fn(async (_params: { amount: bigint }) => ({
    ok: true,
    txHash: '0xabc',
    account: '0xacc',
  })),
  withdraw: vi.fn(async (_params: { balance: bigint }) => ({
    ok: true,
    txHash: '0xdef',
    account: '0xacc',
  })),
  needsUnlock: false,
  unavailable: false,
  unlock: vi.fn(),
};
vi.mock('@/lib/trade/useMarketFunding', () => ({
  useMarketFunding: () => fundingMock,
}));

/** The shielded pool figure the panel shows on the right. */
const poolMock = vi.fn(async () => ({
  total: 500_000_000n,
  spendable: 500_000_000n,
  pendingChange: 0n,
  syncing: false,
}));
vi.mock('@/lib/pool/useShieldedPool', () => ({
  useShieldedPool: () => ({
    balance: (...args: unknown[]) => poolMock(...(args as [])),
    held: async () => ({ total: 0n, operations: [] }),
    deposit: async () => undefined,
    withdraw: async () => undefined,
  }),
}));

/** What the market's execution account holds on chain. */
const stateMock = vi.fn(async () => ({ balance: 0n, allowance: 0n }));
vi.mock('@/lib/execution/account-state', () => ({
  readAccountState: (...args: unknown[]) => stateMock(...(args as [])),
}));

const MARKET_ID = '11111111-1111-4111-8111-111111111111';

function market() {
  return makeMarket({
    id: MARKET_ID,
    engine: 'LS_LMSR',
    outcomes: [makeOutcome(0, 'Argentina', 50), makeOutcome(1, 'France', 50)],
  });
}

/** Render with the amount field controlled, the way `TradePanel` wires it. */
function Harness({ initial = '' }: { initial?: string }) {
  const [amount, setAmount] = React.useState(initial);
  return <MarketAccount market={market()} amount={amount} onAmountChange={setAmount} />;
}

beforeEach(() => {
  session.status = 'authenticated';
  unlinkMock.status = 'ready';
  fundingMock.unavailable = false;
  fundingMock.needsUnlock = false;
  fundingMock.deposit.mockClear();
  fundingMock.withdraw.mockClear();
  stateMock.mockClear().mockResolvedValue({ balance: 0n, allowance: 0n });
  // Reset too: a test that puts the pool mid-settlement must not leak that into the next.
  poolMock.mockClear().mockResolvedValue({
    total: 500_000_000n,
    spendable: 500_000_000n,
    pendingChange: 0n,
    syncing: false,
  });
});

describe('MarketAccount — the setup step', () => {
  it('says what it is for on the tin (positive)', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('heading', { name: /top up this market/i })).toBeInTheDocument();
  });

  it('shows both ends of the transfer (positive)', async () => {
    renderWithProviders(<Harness />);
    expect(screen.getByText('Market')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(await screen.findByText('$500')).toBeInTheDocument();
  });

  it('shows an unfunded market as needing funds, not as missing (negative)', async () => {
    // There is no "this market has not been set up" state any more: the account is derived, so it
    // exists the moment the session unlocks. The only question left is whether it holds anything,
    // and $0 with "Needs funds" says exactly that. The old copy — "Empty", "Step 1 of 2" — came
    // from a registry lookup that now always misses, which is why a funded market read as empty.
    renderWithProviders(<Harness />);
    expect(await screen.findByText(/needs funds/i)).toBeInTheDocument();
  });

  it('reports the account as ready once it holds collateral (positive)', async () => {
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 12_500_000n });

    renderWithProviders(<Harness />);
    expect(await screen.findByText('$12.5')).toBeInTheDocument();
    expect(screen.getByText(/ready to trade/i)).toBeInTheDocument();
  });

  it('keeps the explanation behind the info button (positive)', async () => {
    // The resting panel is two figures, a field and a button. Everything that explains the model
    // changes nothing about what a trader does next, so it is disclosed rather than displayed.
    renderWithProviders(<Harness />);
    const primer = /shielded account that belongs to this market alone/i;
    expect(screen.queryByText(primer)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /what is a market account/i }));
    expect(screen.getByText(primer)).toBeInTheDocument();
  });
});

describe('MarketAccount — depositing', () => {
  it('sends the typed amount in base units (positive)', async () => {
    renderWithProviders(<Harness />);
    await userEvent.type(screen.getByLabelText(/amount to add/i), '25');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(fundingMock.deposit).toHaveBeenCalledTimes(1);
    expect(fundingMock.deposit.mock.calls[0][0]).toMatchObject({ amount: 25_000_000n });
  });

  it('fills the field from a quick amount (positive)', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: '$50' }));
    expect(screen.getByLabelText(/amount to add/i)).toHaveValue(50);
  });

  it('refuses to send more than the private balance holds (negative)', async () => {
    renderWithProviders(<Harness />);
    await screen.findByText('$500');
    await userEvent.type(screen.getByLabelText(/amount to add/i), '900');

    expect(screen.getByText(/more than your private balance/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
    expect(fundingMock.deposit).not.toHaveBeenCalled();
  });

  it('will not send zero or an empty field (negative)', async () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/amount to add/i), '0');
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });

  it('says nothing about outages when there are none (negative)', async () => {
    // The panel carried a standing warning while our own batch was mis-sized. It must not
    // outlive the bug it described.
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /what is a market account/i }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/currently failing/i)).not.toBeInTheDocument();
  });
});

describe('MarketAccount — the money is re-read after it moves', () => {
  it('re-reads the market balance once a top-up lands (REGRESSION)', async () => {
    // The invalidation named `['unlink', 'market-account']`. The query registers under
    // `['execution', 'market-account', ...]`, so it matched nothing: after a top-up the figure sat
    // on its previous value — very often zero, since the transfer people notice most is their
    // first — until the twelve-second poll came round, and a reconnect was the only thing that
    // visibly fixed it.
    renderWithProviders(<Harness />);
    await screen.findByText('$500');
    const before = stateMock.mock.calls.length;

    await userEvent.type(screen.getByLabelText(/amount to add/i), '25');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(stateMock.mock.calls.length).toBeGreaterThan(before), {
      timeout: 3_000,
    });
  });

  it('re-reads the private balance too (positive)', async () => {
    // Both ends of the transfer, refreshed together — a panel showing a new market balance beside
    // a stale private one is a panel that appears to have created money.
    renderWithProviders(<Harness />);
    await screen.findByText('$500');
    const before = poolMock.mock.calls.length;

    await userEvent.type(screen.getByLabelText(/amount to add/i), '25');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(poolMock.mock.calls.length).toBeGreaterThan(before), {
      timeout: 3_000,
    });
  });
});

describe('MarketAccount — withdrawing', () => {
  it('offers no withdrawal when the account is empty (negative)', () => {
    renderWithProviders(<Harness />);
    expect(screen.queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
  });

  it('returns the whole balance to the private balance in one press (positive)', async () => {
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 0n });

    renderWithProviders(<Harness />);
    const button = await screen.findByRole('button', {
      name: /withdraw \$12\.5 to private balance/i,
    });
    expect(button).toBeEnabled();

    await userEvent.click(button);
    expect(fundingMock.withdraw).toHaveBeenCalledTimes(1);
    expect(fundingMock.withdraw.mock.calls[0][0]).toMatchObject({ balance: 12_500_000n });
  });

  it('asks for no destination address (REGRESSION)', async () => {
    // While the return leg was thought broken this offered a public cash-out with an address
    // field. Money now goes back the way it came, and an address here would be a privacy leak
    // asking to happen.
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 0n });

    renderWithProviders(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: /withdraw/i }));
    expect(screen.queryByPlaceholderText('0x…')).not.toBeInTheDocument();
    expect(screen.queryByText(/fresh address/i)).not.toBeInTheDocument();
  });

  it('keeps the way out visible, not buried (positive)', async () => {
    // A withdrawal a trader has to go looking for is one they assume does not exist. It sits in
    // the resting panel the moment there is anything to take out.
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 0n });

    renderWithProviders(<Harness />);
    expect(await screen.findByRole('button', { name: /withdraw/i })).toBeInTheDocument();
    // Without opening the disclosure.
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('MarketAccount — gating', () => {
  it('offers the unlock rather than a deposit form when locked (negative)', () => {
    unlinkMock.status = 'locked';
    fundingMock.needsUnlock = true;

    renderWithProviders(<Harness />);
    expect(screen.getByRole('button', { name: /unlock private trading/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/amount to add/i)).not.toBeInTheDocument();
  });

  it('says plainly when the deployment has no privacy layer (negative)', () => {
    unlinkMock.status = 'unavailable';
    fundingMock.unavailable = true;

    renderWithProviders(<Harness />);
    expect(screen.getByRole('note')).toHaveTextContent(/no privacy layer configured/i);
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
  });

  it('names the missing sign-in instead of offering an unlock (REGRESSION)', () => {
    // The privacy layer reports `locked` to a visitor and a trader alike, so this panel used to
    // put a live "Unlock private trading" in front of somebody with no account. Pressing it
    // opened a wallet prompt for a key the page could not name, and failed describing a
    // signature rather than the step that was actually missing.
    session.status = 'anonymous';
    unlinkMock.status = 'locked';
    fundingMock.needsUnlock = true;

    renderWithProviders(<Harness />);

    expect(screen.queryByRole('button', { name: /unlock private trading/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in to add funds/i })).toBeDisabled();
    expect(fundingMock.unlock).not.toHaveBeenCalled();
  });

  it('waits rather than guessing while the session is being restored (negative)', () => {
    session.status = 'loading';
    unlinkMock.status = 'locked';
    fundingMock.needsUnlock = true;

    renderWithProviders(<Harness />);

    expect(screen.queryByRole('button', { name: /unlock private trading/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in to add funds/i })).not.toBeInTheDocument();
  });
});

describe('MarketAccount — change still settling', () => {
  /** A pool mid-settlement: the change note from a top-up exists but is not yet spendable. */
  function settling() {
    poolMock.mockResolvedValue({
      total: 500_000_000n,
      spendable: 489_000_000n,
      pendingChange: 11_000_000n,
      syncing: false,
    });
  }

  it('shows what the trader owns, not only what has settled (REGRESSION)', async () => {
    // A shielded pool spends whole notes and mints change, so topping up 10 out of 500 nullifies
    // the 500-note and leaves a 490 change note Engine will not count until it resolves. Showing
    // `spendable` alone made the private balance drop by the whole note after every top-up and
    // climb back minutes later — reported as "it was 489 and somehow became 500". Nothing moved
    // either time.
    settling();
    renderWithProviders(<Harness />);
    expect(await screen.findByText('$500')).toBeInTheDocument();
    expect(screen.queryByText('$489')).not.toBeInTheDocument();
  });

  it('names the part that is still landing (positive)', async () => {
    settling();
    renderWithProviders(<Harness />);
    expect(await screen.findByText(/\$11 settling/i)).toBeInTheDocument();
  });

  it('calls an unsettled amount a wait, not an overdraft (positive)', async () => {
    // 495 is within what they own but beyond what has settled. Telling someone their balance is
    // smaller than the figure printed directly above it, with no explanation, is how a working
    // product loses trust.
    settling();
    renderWithProviders(<Harness />);
    await screen.findByText('$500');
    await userEvent.type(screen.getByLabelText(/amount to add/i), '495');

    expect(screen.getByText(/ready now/i)).toBeInTheDocument();
    expect(screen.queryByText(/more than your private balance/i)).not.toBeInTheDocument();
  });

  it('still refuses more than they actually own (negative)', async () => {
    settling();
    renderWithProviders(<Harness />);
    await screen.findByText('$500');
    await userEvent.type(screen.getByLabelText(/amount to add/i), '900');

    expect(screen.getByText(/more than your private balance/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });
});

describe('MarketAccount — one operation at a time', () => {
  it('refuses to start a transfer while a trade is settling (negative)', async () => {
    // Funding and trading both move this market's account. Sequencing them keeps a top-up from
    // crossing a bet that is still settling, which would otherwise read to the trader as one of
    // the two silently not happening.
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 0n });

    renderWithProviders(
      <MarketAccount market={market()} amount="25" onAmountChange={() => {}} blocked />,
    );

    // Awaited: the withdrawal only appears once the on-chain balance read resolves.
    expect(await screen.findByRole('button', { name: /withdraw/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
    expect(screen.getByText(/cannot cross/i)).toBeInTheDocument();
  });

  it('announces when a transfer starts and stops (positive)', async () => {
    // The ticket below stands down on this signal; without it, both panels stay live.
    const seen: boolean[] = [];
    renderWithProviders(<Harness />);
    expect(seen).toEqual([]);

    renderWithProviders(
      <MarketAccount
        market={market()}
        amount="25"
        onAmountChange={() => {}}
        onBusyChange={(b) => seen.push(b)}
      />,
    );
    await screen.findAllByText('$500');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[1]);

    expect(seen).toContain(true);
    // Not immediately: the finished animation is held up for a beat before the panel returns, so
    // the transfer is still "busy" for a moment after the transfer itself has landed.
    await waitFor(() => expect(seen.at(-1)).toBe(false), { timeout: 3_000 });
  });
});

describe('MarketAccount — reading before acting', () => {
  it('sweeps the balance as it stands at the press, not at the last poll (REGRESSION)', async () => {
    // The sweep is capped at the figure it is handed, and this balance is polled every twelve
    // seconds. A sale settling in between would leave the difference behind as dust, in an
    // account the trader has just been told is empty.
    stateMock.mockResolvedValue({ balance: 12_500_000n, allowance: 0n });

    renderWithProviders(<Harness />);
    const button = await screen.findByRole('button', { name: /withdraw \$12\.5/i });

    // A sale lands between the last poll and the press.
    stateMock.mockResolvedValue({ balance: 20_000_000n, allowance: 0n });
    await userEvent.click(button);

    expect(fundingMock.withdraw.mock.calls[0][0]).toMatchObject({ balance: 20_000_000n });
  });

  it('says nothing about overdrafts before the balance is known (negative)', async () => {
    // Treating "not read yet" as zero told anyone who typed in the first second that their amount
    // was more than a balance of $0, and disabled the button that would have proved otherwise.
    poolMock.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<Harness />);
    await userEvent.type(screen.getByLabelText(/amount to add/i), '900');

    expect(screen.queryByText(/more than your private balance/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });
});

