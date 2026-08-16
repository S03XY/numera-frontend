import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeTicket } from './TradeTicket';
import { renderWithProviders, makeMarket, makeOutcome } from '@/test/render';
import { endpoints } from '@/lib/api/endpoints';
import { addExecutionAccount, clearExecutionAccounts } from '@/lib/portfolio/account-store';
import type { Position } from '@/lib/api/types';

const sessionMock = { status: 'authenticated' as string };
vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => sessionMock,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Balances and addresses come from the execution layer now, which needs an unlocked session to
// derive anything. Stubbed so these tests stay about the ticket's own arithmetic — derivation has
// its own suite against the real curve, in `keys.test.ts`.
// The guard sent on chain comes from the engine's own quote, not from the ticket's local curve —
// see `useContractQuote` for why that distinction matters. Stubbed so these tests do not need a
// chain; the arithmetic on top of it is what they are checking.
const contractQuote = { total: 12_000_000n as bigint | null, minTrade: 5_000_000n as bigint | null };
vi.mock('@/lib/trade/useContractQuote', () => ({
  useContractQuote: () => ({ total: contractQuote.total, isFetching: false, isError: false }),
  useMinTradeCost: () => contractQuote.minTrade,
}));

/**
 * A stand-in for the on-chain solve, priced at a flat rate per share.
 *
 * Faithful in the one way that matters here: it spends `target` — the budget less the slippage
 * headroom — and never the budget itself, so any test that confuses "what was typed" with "what
 * gets spent" fails. The real solver's convergence is exercised against the curve in its own
 * suite; what the ticket owes is the arithmetic on top of it.
 */
const budgetMock = {
  /** Base units of collateral per whole share. */
  pricePerShare: 600_000n,
  /** No size fits — the solve failed, or the book could not price it. */
  unsolvable: false,
};
vi.mock('@/lib/trade/useSharesForBudget', () => ({
  useSharesForBudget: ({
    budget,
    target,
    enabled,
  }: {
    budget: bigint | null;
    target: bigint | null;
    enabled?: boolean;
  }) => {
    if (enabled === false || budget === null || target === null || budgetMock.unsolvable) {
      return { shares: null, cost: null, isFetching: false, isError: budgetMock.unsolvable };
    }
    return {
      shares: (target * 1_000_000n) / budgetMock.pricePerShare,
      cost: target,
      isFetching: false,
      isError: false,
    };
  },
}));

vi.mock('@/lib/execution/useExecutionAccounts', () => ({
  useExecutionAccounts: () => ['0xaaaa111111111111111111111111111111111111'],
}));
const accountMock = { balance: 25_000_000n, allowance: 0n };
vi.mock('@/lib/execution/useMarketAccount', () => ({
  useMarketAccountBalance: () => ({
    address: '0xaaaa111111111111111111111111111111111111' as `0x${string}`,
    balance: accountMock.balance,
    // What the ticket sizes and gates on. Separate from `balance` in the real hook, which may
    // include a deposit still in flight — the ticket must never spend one of those.
    settledBalance: accountMock.balance,
    pending: false,
    allowance: accountMock.allowance,
    unset: false,
    known: true,
    isPending: false,
    isError: false,
    refetch: async () => accountMock.balance,
  }),
}));

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    positions: { forAccounts: vi.fn(async () => [] as unknown[]) },
    // Read by PoolProvider on mount; a build with no privacy layer is the test default.
    unlink: { environment: vi.fn(async () => ({ enabled: false })) },
  },
}));

// Mirrors the real hook's default in a test build (no Unlink configured), so the gating tests
// below still exercise the unavailable path — but lets the colour tests reach the commit button.
const tradeMock = {
  submit: vi.fn(),
  needsUnlock: false,
  unavailable: true,
  paused: null as 'disabled' | 'capped' | null,
  unlock: vi.fn(),
};
vi.mock('@/lib/trade/useSubmitTrade', () => ({
  useSubmitTrade: () => tradeMock,
}));

/**
 * The ticket now reads a real balance, so the privacy layer's status decides whether it knows
 * anything at all. `unavailable` is the honest default for a test build with no Unlink
 * configured; the funding tests raise it to `ready`, which is the only state in which a shortfall
 * can be asserted — an unknown balance must never present as an empty one.
 *
 * The provider is passed through rather than mocked away: `renderWithProviders` mounts it, and
 * replacing it with `undefined` stops the whole tree rendering.
 */
const unlinkMock = {
  status: 'unavailable' as string,
  client: null as unknown,
  address: null as string | null,
  environment: null as unknown,
  reason: null as string | null,
  unlock: vi.fn(),
};
vi.mock('@/lib/pool/PoolProvider', () => ({
  usePool: () => unlinkMock,
  PoolProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const USDC = 1_000_000;

function lmsrMarket(over = {}) {
  return makeMarket({
    engine: 'LS_LMSR',
    outcomes: [
      { ...makeOutcome(0, 'Argentina', 50), shares: '0' },
      { ...makeOutcome(1, 'France', 50), shares: '0' },
    ],
    ...over,
  });
}

const forAccounts = endpoints.positions.forAccounts as unknown as ReturnType<typeof vi.fn>;
const ACCOUNT = '0xaaaa111111111111111111111111111111111111';

const MARKET_ID = '11111111-1111-4111-8111-111111111111';

function position(
  outcomeIndex: number,
  shares: bigint,
  money: { value?: bigint; basis?: bigint } = {},
): Position {
  return {
    marketRef: MARKET_ID,
    marketTitle: 'Argentina vs France',
    marketStatus: 'TRADING',
    engine: 'LS_LMSR',
    marketAddress: '0xbbbb111111111111111111111111111111111111',
    marketOnChainId: '7',
    collateral: '0xcccc111111111111111111111111111111111111',
    account: ACCOUNT,
    outcomeIndex,
    outcomeLabel: `Outcome ${outcomeIndex}`,
    shares: shares.toString(),
    costBasis: (money.basis ?? 0n).toString(),
    realizedPnl: '0',
    redeemed: false,
    currentPriceWad: '500000000000000000',
    winningOutcomeId: null,
    markToMarket: (money.value ?? 0n).toString(),
  };
}

/**
 * Type a size and wait for the panel to reprice.
 *
 * The box is debounced before anything reaches the chain — sizing a bet by budget costs a solve,
 * and every keystroke of "50" would otherwise price a bet of 5. So every assertion about a quote,
 * a guard or a shortfall has to wait for it; a synchronous read sees the state from before the
 * keystroke and then passes or fails for a reason that has nothing to do with the test.
 */
async function typeSize(label: string, value: string) {
  await userEvent.type(screen.getByLabelText(label), value);
  await screen.findByText(/never spends more than|reverts below/i);
}

/** Put holdings on the wire and register the account that owns them. */
function holding(...positions: Position[]) {
  addExecutionAccount(ACCOUNT);
  forAccounts.mockResolvedValue(positions);
}

beforeEach(() => {
  sessionMock.status = 'authenticated';
  tradeMock.needsUnlock = false;
  tradeMock.unavailable = true;
  tradeMock.paused = null;
  tradeMock.submit.mockReset();
  // Reset the engine's quote too: a null left behind by one test disables the commit button in
  // every test after it, for a reason that has nothing to do with what they are checking.
  contractQuote.total = 12_000_000n;
  contractQuote.minTrade = 5_000_000n;
  budgetMock.pricePerShare = 600_000n;
  budgetMock.unsolvable = false;
  accountMock.balance = 25_000_000n;
  unlinkMock.status = 'unavailable';
  clearExecutionAccounts();
  forAccounts.mockReset().mockResolvedValue([]);
});

describe('TradeTicket — LMSR', () => {
  it('offers YES and NO on every outcome within the active section (positive)', () => {
    // The section (buy/sell) is chosen once at the top; YES/NO belongs to each outcome, so the
    // labels below are scoped to whichever section is active.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    expect(screen.getByRole('button', { name: /^buy yes on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy no on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy yes on France$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy no on France$/i })).toBeInTheDocument();
  });

  it('starts on buy for the first outcome (positive)', () => {
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(screen.getByRole('button', { name: /^buy yes on Argentina$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('marks exactly one outcome/side pair as chosen (regression)', async () => {
    // Two highlighted controls would leave the user guessing what a submit does.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('button', { name: /^buy no on France$/i }));

    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveAccessibleName(/buy no on France/i);
  });

  it('sizes a buy in dollars and answers in shares (positive)', async () => {
    // The direction a bettor actually thinks in: they name the stake, and how many shares it buys
    // is the curve's business. $30 at 60c a share, less the 1% held back for slippage, is 49.5.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '30');

    expect(await screen.findByText('49.5 YES shares')).toBeInTheDocument();
    expect(screen.getByText('You pay')).toBeInTheDocument();
    expect(screen.getByText('Price per share')).toBeInTheDocument();
  });

  it('keeps the desk jargon off the bet slip (REGRESSION)', async () => {
    // Spread, average price and the price the trade leaves behind are figures from a derivatives
    // desk. The spread is stated once in the market's Details panel; the resulting price is not a
    // fact about the reader's bet at all. Four rows, all of them money they care about.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await typeSize('Amount to spend (USDC)', '30');

    expect(screen.queryByText('Spread')).not.toBeInTheDocument();
    expect(screen.queryByText('Price after')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg price')).not.toBeInTheDocument();
  });

  it('fixes the tolerance rather than asking about it (REGRESSION)', async () => {
    // Four buttons and a paragraph for a setting that, since the cap became the typed figure,
    // only decides how much of a stake gets spent. It is 1% and it is stated, not configured.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await typeSize('Amount to spend (USDC)', '30');

    expect(screen.queryByRole('button', { name: '1%' })).not.toBeInTheDocument();
    expect(screen.queryByText(/max slippage/i)).not.toBeInTheDocument();
    expect(screen.getByText(/never spends more than/i)).toBeInTheDocument();
  });

  it('states the payout in money, not only in shares (positive)', async () => {
    // A share settles at exactly 1, so the size IS the return — but leaving the reader to make
    // that leap is the difference between a derivatives quote and a bet slip.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '30');

    expect(await screen.findByText('Pays if Argentina wins')).toBeInTheDocument();
    expect(screen.getByText('$49.50')).toBeInTheDocument();
  });

  it('shows no quote until a positive amount is entered (negative)', async () => {
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(screen.queryByText('You pay')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '0');
    expect(screen.queryByText('You pay')).not.toBeInTheDocument();
  });

  /**
   * Between typing and the quote landing there is a debounce and a round trip, and the panel used
   * to render *nothing at all* across both. A second of a page that has visibly not reacted is what
   * "it feels stuck" describes, and the page really was doing nothing observable.
   */
  it('says it is working while the quote is being solved (REGRESSION)', async () => {
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '30');

    // Present the moment there is an amount to price, and gone once there are figures to read.
    expect(screen.getByRole('status', { name: /working out the price/i })).toBeInTheDocument();
    expect(await screen.findByText('You pay')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: /working out the price/i })).not.toBeInTheDocument(),
    );
  });

  it('stays quiet when there is nothing to price (negative)', async () => {
    // An empty box is not a pending quote. A placeholder that appears before you have typed
    // anything is noise rather than feedback.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(screen.queryByRole('status', { name: /working out the price/i })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '0');
    expect(screen.queryByRole('status', { name: /working out the price/i })).not.toBeInTheDocument();
  });

  it('clears the quote when the box is cleared (REGRESSION)', async () => {
    // The solve holds its previous answer while a new one is in flight, or the panel blinks between
    // empty and priced on every keystroke. But "previous" outlived the input being emptied, so a
    // cleared box sat under a live-looking quote — 12.59 shares for $9.90 over a field reading 0.00.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    const box = screen.getByLabelText('Amount to spend (USDC)');
    await typeSize('Amount to spend (USDC)', '30');
    expect(screen.getByText('You pay')).toBeInTheDocument();

    await userEvent.clear(box);
    await waitFor(() => expect(screen.queryByText('You pay')).not.toBeInTheDocument());
  });

  it('switches to sell, relabels the input and answers in dollars (positive)', async () => {
    // The other direction: shares in, money out. A sale is bounded by what is held and a full
    // exit has to be exact, which a dollar-denominated sale can never be.
    const market = lmsrMarket({
      outcomes: [
        { ...makeOutcome(0, 'Argentina', 50), shares: String(5_000 * USDC) },
        { ...makeOutcome(1, 'France', 50), shares: '0' },
      ],
    });
    renderWithProviders(<TradeTicket market={market} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^sell yes on Argentina$/i }));
    expect(screen.getByLabelText('Shares to sell')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Shares to sell'), '1000');
    expect(await screen.findByText('You receive')).toBeInTheDocument();
    expect(screen.getByText('$12.00')).toBeInTheDocument();
    // A sale is not a stake, so there is nothing to hold back and no payout to project.
    expect(screen.queryByText('You pay')).not.toBeInTheDocument();
  });

  it('clears the box when the tab changes the unit (REGRESSION)', async () => {
    // Buy is denominated in dollars, sell in shares. Leaving "50" in place while it silently stops
    // meaning fifty dollars and starts meaning fifty shares is the one way this design can hurt
    // someone — a 50-share sale where a $50 sale was intended, or the reverse.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '50');
    expect(screen.getByLabelText('Amount to spend (USDC)')).toHaveValue(50);

    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(screen.getByLabelText('Shares to sell')).toHaveValue(null);
  });

  it('quotes a sale against the book, and the contract rejects an oversized one (negative)', async () => {
    // The ticket quotes what the curve would pay; whether the trader actually HOLDS that many
    // shares is enforced on-chain by `InsufficientShares`, not guessed at here. Blocking the
    // quote client-side would also block a legitimate partial exit.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^sell yes on Argentina$/i }));
    await userEvent.type(screen.getByLabelText('Shares to sell'), '1000');
    expect(await screen.findByText('You receive')).toBeInTheDocument();
  });

  it('spends the tolerance out of the stake rather than on top of it (safety)', async () => {
    // The 1% held back buys fewer shares; it never raises the bill. $1000 at 60c a share, less
    // 1%, is 1,650 — not the 1,666 the full budget would buy.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await typeSize('Amount to spend (USDC)', '1000');

    expect(screen.getByText('1,650 YES shares')).toBeInTheDocument();
    expect(screen.getByText(/never spends more than/i)).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
  });

  it('caps a buy at exactly what was typed, never a percentage above it (REGRESSION)', async () => {
    // The guard used to be the engine's quote inflated by the tolerance, so a $10 bet could be
    // billed $10.12 — and a "100%" button, which is the whole balance, would have been a
    // guaranteed revert. The cap is now the trader's own figure and the tolerance is funded out of
    // it, which is the only arrangement in which spending your entire balance is a valid trade.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await typeSize('Amount to spend (USDC)', '10');
    await userEvent.click(screen.getByRole('button', { name: /buy privately/i }));

    const sent = tradeMock.submit.mock.calls[0][0];
    expect(sent.guard).toBe(10_000_000n);
    // ...and the size is the one solved against the engine, not the number in the box.
    expect(sent.size).toBe(16_500_000n);
  });

  it('will not submit before the engine has priced the trade (safety)', async () => {
    // No solved size means no trade. Submitting anyway would send whatever the local estimate
    // said, which is the thing this all exists to stop.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    budgetMock.unsolvable = true;
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '10');

    expect(screen.getByRole('button', { name: /buy privately/i })).toBeDisabled();
  });

  it('refuses a bet under the engine\'s floor, and says the figure (REGRESSION)', async () => {
    // The engine rejects these on chain, and the relay could only report "the market would not
    // accept your bet — the price may have moved". Which was wrong: the price was fine, the bet was
    // a dollar. The ticket has to know the floor and say so before anything is signed.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '1');

    const button = await screen.findByRole('button', { name: /minimum bet is \$5/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/covers the network fee/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy privately/i })).not.toBeInTheDocument();
  });

  it('asks for a budget the engine floor can actually be cleared inside (REGRESSION)', async () => {
    // Found by probing the live engine. A $5 budget against a $5 floor has to cost exactly $5.00 to
    // the base unit — the floor bounds the cost from below and the budget caps it from above — and
    // no discrete share count lands there. It solved to $4.9992 and would have been rejected on
    // chain as `AmountBelowMin`, with the trader having typed the very figure the panel called the
    // minimum. So the stated minimum is the floor plus a percent, which is also the slippage room
    // such a bet gets.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await typeSize('Amount to spend (USDC)', '5');

    expect(await screen.findByRole('button', { name: /minimum bet is \$5\.05/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /buy privately/i })).not.toBeInTheDocument();
  });

  it('sizes a bet at that minimum so it clears the floor (positive)', async () => {
    // And at $5.05 the band is [floor $5.00, cap $5.05], which a real size does land inside.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await typeSize('Amount to spend (USDC)', '5.05');
    await userEvent.click(screen.getByRole('button', { name: /buy privately/i }));

    const sent = tradeMock.submit.mock.calls[0][0];
    expect(sent.guard).toBe(5_050_000n);
    expect(sent.size).toBeGreaterThan(0n);
  });

  it('states the privacy guarantee on request (PRIVACY)', async () => {
    // It used to sit permanently under the commit button, where it was read once and then
    // occupied the panel forever. One press away is still available; a paragraph nobody reads
    // twice is not worth the space next to the money.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('button', { name: /how private trading works/i }));
    expect(screen.getByText(/shielded account/i)).toBeInTheDocument();
  });
});

describe('TradeTicket — buy/sell sections with yes/no per outcome', () => {
  it('offers exactly two sections, not a third action (regression)', () => {
    // Buy and Sell are sections; YES/NO is the side of an outcome. A third top-level "short"
    // button conflated the two questions and is the thing this layout removes.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.toLowerCase())).toEqual(['buy', 'sell']);
  });

  it('gives every outcome its own YES and NO (positive)', () => {
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(screen.getByRole('button', { name: /^buy yes on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy no on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy yes on France$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^buy no on France$/i })).toBeInTheDocument();
  });

  it('explains what NO actually pays (positive)', async () => {
    // A trader must not have to infer that NO means buying every other outcome.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('button', { name: /^buy no on Argentina$/i }));
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '100');
    expect(
      await screen.findByText(/one share of every other outcome — pays 1 each if Argentina loses/i),
    ).toBeInTheDocument();
    // And the payout line names the condition, which for NO is the outcome LOSING.
    expect(screen.getByText('Pays if Argentina loses')).toBeInTheDocument();
  });

  it('switching to Sell keeps the YES/NO choice on each outcome (positive)', async () => {
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(screen.getByRole('button', { name: /^sell yes on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sell no on Argentina$/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Shares to sell')).toBeInTheDocument();
  });
});

describe('TradeTicket — buy is green, sell is red', () => {
  const tab = (name: 'buy' | 'sell') => screen.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') });

  it('colours the two sections differently rather than sharing one accent (positive)', async () => {
    // The whole point of the section split is that you can tell which one you are in without
    // reading. A single accent on both — which is what this used to be — collapses that back.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    const buyActive = tab('buy').className;
    expect(buyActive).toMatch(/\bborder-pos\b/);
    expect(buyActive).not.toMatch(/\bborder-neg\b/);

    await userEvent.click(tab('sell'));
    const sellActive = tab('sell').className;
    expect(sellActive).toMatch(/\bborder-neg\b/);
    expect(sellActive).not.toMatch(/\bborder-pos\b/);
    expect(sellActive).not.toBe(buyActive);
  });

  it('drops the colour from whichever section is not active (negative)', async () => {
    // Two coloured tabs would read as two live states.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(tab('sell').className).not.toMatch(/\b(border|text|bg)-neg\b/);

    await userEvent.click(tab('sell'));
    expect(tab('buy').className).not.toMatch(/\b(border|text|bg)-pos\b/);
  });

  it('carries the section colour onto the button that commits the trade (positive)', async () => {
    tradeMock.unavailable = false;
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '100');
    expect(screen.getByRole('button', { name: /buy privately/i })).toHaveClass('btn-pos');

    await userEvent.click(tab('sell'));
    expect(screen.getByRole('button', { name: /sell privately/i })).toHaveClass('btn-neg');
  });

  it('leaves the unlock prompt on the brand accent, not a direction (negative)', async () => {
    // Unlocking is not a buy. A green button before any size is entered would say otherwise.
    tradeMock.unavailable = false;
    tradeMock.needsUnlock = true;
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    const unlock = screen.getByRole('button', { name: /unlock private trading/i });
    expect(unlock).toHaveClass('btn-primary');
    expect(unlock.className).not.toMatch(/btn-(pos|neg)/);
  });

  it('keeps YES green and NO red inside the red sell section (regression)', async () => {
    // Section colour and side colour answer different questions, so the sell section must not
    // repaint its YES button red just because the tab is red.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(tab('sell'));
    await userEvent.click(screen.getByRole('button', { name: /^sell yes on Argentina$/i }));

    expect(screen.getByRole('button', { name: /^sell yes on Argentina$/i }).className).toMatch(
      /\bbg-pos\b/,
    );
    expect(screen.getByRole('button', { name: /^sell no on Argentina$/i }).className).toMatch(
      /\btext-neg\b/,
    );
  });
});

describe('TradeTicket — balance and holdings', () => {
  const lmsr3 = () =>
    lmsrMarket({
      id: MARKET_ID,
      outcomeCount: 3,
      outcomes: [
        { ...makeOutcome(0, 'Argentina', 40), shares: '0' },
        { ...makeOutcome(1, 'France', 35), shares: '0' },
        { ...makeOutcome(2, 'Draw', 25), shares: '0' },
      ],
    });

  it('states the spending balance on both tabs (positive)', async () => {
    // It used to sit beside the size field on Buy only, so "can I afford this?" was unanswerable
    // while deciding, and absent on Sell where it says whether the proceeds landed.
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(screen.getByText('Market balance')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(screen.getByText('Market balance')).toBeInTheDocument();
  });

  it('quotes the MARKET balance, not the private one (REGRESSION)', () => {
    // These are different quantities and only one of them can pay for a bet: collateral in the
    // shielded pool has to reach this market's execution account first. Showing the pool figure
    // here offered sizes the ticket had no way to fill, and it belongs on the funding panel
    // instead — beside the control that actually moves it.
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(screen.getAllByText(/market balance/i)).toHaveLength(1);
    expect(screen.queryByText(/private balance/i)).not.toBeInTheDocument();

    // Asserted on the size field's own label row rather than the panel: money belongs at the top,
    // and this row carries only what is specific to the tab. The percentage buttons underneath
    // are a percentage OF that top figure, which is why it must not be reprinted here.
    const labelRow = screen.getByText('Amount to spend (USDC)').parentElement;
    expect(labelRow?.textContent).not.toMatch(/\$/);
  });

  it('shows what the position here is worth, beside the balance (positive)', async () => {
    holding(position(0, 12_000_000n, { value: 7_000_000n, basis: 5_000_000n }));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);

    expect(await screen.findByText('$7')).toBeInTheDocument();
    // The move rather than a second copy of the value — the panel below carries the breakdown.
    expect(screen.getByText('+$2')).toBeInTheDocument();
  });

  it('marks a losing position with the negative tone (positive)', async () => {
    holding(position(0, 12_000_000n, { value: 3_000_000n, basis: 5_000_000n }));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(await screen.findByText('-$2')).toHaveClass('text-neg');
  });

  it('sums a position spread across outcomes (regression)', async () => {
    // A NO position is held as one line per other outcome, and after a restore one market can be
    // held by more than one execution account. Either way the header is a total, not a row.
    holding(
      position(0, 4_000_000n, { value: 2_000_000n, basis: 1_000_000n }),
      position(1, 4_000_000n, { value: 3_000_000n, basis: 2_000_000n }),
    );
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(await screen.findByText('$5')).toBeInTheDocument();
  });

  it('says nothing rather than zero when you hold none of this market (negative)', () => {
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    const position = screen.getByText('Your position').closest('div');
    expect(position).toHaveTextContent('—');
    expect(position).not.toHaveTextContent('$0');
  });

  it('states what you hold on one line, below the prices (positive)', async () => {
    holding(position(0, 12_000_000n)); // 12 shares
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(await screen.findByText(/you hold 12 yes/i)).toBeInTheDocument();
  });

  it('keeps holdings out of the outcome rows (REGRESSION)', async () => {
    // A share count on the row competed with a colour, a name, a price and two side buttons for a
    // narrow column, and lost — it truncated "Argentina" to "A…". Nothing about a holding changes
    // what the trader does next, so it does not belong in the control they are reading.
    holding(position(0, 12_000_000n));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await screen.findByText(/you hold 12 yes/i);

    expect(screen.getByRole('radio', { name: /^select Argentina$/i })).not.toHaveTextContent(/held/i);
    expect(screen.queryByText('12 held')).not.toBeInTheDocument();
  });

  it('names only the side actually held (negative)', async () => {
    // A "0 NO" beside every outcome nobody has shorted is noise that hides the one real position.
    holding(position(0, 12_000_000n));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await screen.findByText(/you hold 12 yes/i);
    expect(screen.queryByText(/0 no/i)).not.toBeInTheDocument();
  });

  it('fills the whole position on 100% (positive)', async () => {
    holding(position(0, 6_500_000n)); // 6.5 shares
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);

    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(await screen.findByText(/you hold 6\.5 yes/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByLabelText('Shares to sell')).toHaveValue(6.5);
  });

  it('takes a percentage of the position, exactly (positive)', async () => {
    // Floored rather than rounded, and 100% taken as the balance itself rather than computed —
    // a full exit that leaves a hundredth of a share behind is a position that can never be closed.
    holding(position(0, 6_500_000n));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    await screen.findByText(/you hold 6\.5 yes/i);

    await userEvent.click(screen.getByRole('button', { name: '50%' }));
    expect(screen.getByLabelText('Shares to sell')).toHaveValue(3.25);
    // Sets rather than adds: a percentage of a balance is an absolute size, and adding one to
    // whatever was already typed means nothing at all.
    await userEvent.click(screen.getByRole('button', { name: '25%' }));
    expect(screen.getByLabelText('Shares to sell')).toHaveValue(1.625);
  });

  it('takes a percentage of the MARKET balance on a buy (positive)', async () => {
    // The buy denominator is money, and it is the market account's balance — not the pool's, and
    // not the position's. 100% has to be spendable in full, which is what the budget-as-cap
    // arrangement guarantees.
    unlinkMock.status = 'ready';
    accountMock.balance = 25_000_000n;
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);

    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByLabelText('Amount to spend (USDC)')).toHaveValue(25);

    await userEvent.click(screen.getByRole('button', { name: '25%' }));
    expect(screen.getByLabelText('Amount to spend (USDC)')).toHaveValue(6.25);
  });

  it('sizes a NO exit by the SMALLEST leg, not the largest (REGRESSION)', async () => {
    // A NO position is one share of every other outcome. Offering the biggest leg as the whole
    // position would revert on whichever leg ran out first, after a minute of shielding, with no
    // way for the trader to tell which one.
    holding(position(1, 10_000_000n), position(2, 4_000_000n));
    renderWithProviders(<TradeTicket market={lmsr3()} />);

    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^sell no on Argentina$/i }));

    expect(await screen.findByText(/you hold 4 no/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByLabelText('Shares to sell')).toHaveValue(4);
  });

  it('disables the percentages when there is nothing to size against (negative)', async () => {
    // An enabled "100%" over a balance of nothing fills in a zero and then refuses it. Better to
    // be visibly unavailable than to offer a button whose only outcome is a rejection.
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(screen.getByRole('button', { name: '100%' })).toBeDisabled();
  });

  it('keeps holdings for other markets out of this ticket (regression)', async () => {
    addExecutionAccount(ACCOUNT);
    forAccounts.mockResolvedValue([
      { ...position(0, 99_000_000n), marketRef: 'ffffffff-1111-4111-8111-111111111111' },
    ]);

    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    expect(screen.queryByText('99 held')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100%' })).toBeDisabled();
  });

  it('prices a single share of both sides, in money (positive)', async () => {
    // 60% is a probability; $0.60 is a price. For a contract that settles at exactly 1 the money
    // form is the one that answers "what am I paying and what does it return".
    renderWithProviders(
      <TradeTicket
        market={lmsrMarket({
          id: MARKET_ID,
          outcomes: [
            { ...makeOutcome(0, 'Argentina', 60), shares: '0' },
            { ...makeOutcome(1, 'France', 40), shares: '0' },
          ],
        })}
      />,
    );

    expect(screen.getByText('$0.60')).toBeInTheDocument();
    expect(screen.getByText('$0.40')).toBeInTheDocument();
    expect(screen.getAllByText('per share')).toHaveLength(2);
  });

  it('prices NO as the sum of the other legs, not one minus this one (REGRESSION)', async () => {
    // The marginal prices carry the vig, so they add to slightly more than 1. `1 − p` would
    // understate what the NO side actually costs by exactly the house edge — which is both wrong
    // and wrong in our favour, the worst direction for a number on a bet slip.
    renderWithProviders(
      <TradeTicket
        market={lmsrMarket({
          id: MARKET_ID,
          outcomeCount: 3,
          outcomes: [
            { ...makeOutcome(0, 'Argentina', 50), shares: '0' },
            { ...makeOutcome(1, 'France', 30), shares: '0' },
            { ...makeOutcome(2, 'Draw', 25), shares: '0' },
          ],
        })}
      />,
    );

    // 0.30 + 0.25 = 0.55, which is NOT 1 − 0.50.
    expect(screen.getByText('$0.55')).toBeInTheDocument();
    // Were NO computed as 1 − p it would print $0.50 as well, and there would be two of them.
    expect(screen.getAllByText('$0.50')).toHaveLength(1);
  });

  it('shows the NO balance, which appears nowhere else (positive)', async () => {
    // A NO position is held as one share of every OTHER outcome, so it has no row of its own —
    // without this card the only way to read it is to find the smallest leg by eye.
    holding(position(1, 10_000_000n), position(2, 4_000_000n));
    renderWithProviders(<TradeTicket market={lmsr3()} />);

    // The smallest leg — 4, not 10 — because that is what a NO position actually amounts to.
    expect(await screen.findByText(/you hold 4 no/i)).toBeInTheDocument();
  });
});

describe('TradeTicket — choosing an outcome', () => {
  it('selects an outcome by clicking the row itself (REGRESSION)', async () => {
    // The reported bug: the ticket appeared stuck on the first outcome. It was not stuck — the
    // row was inert scenery and the only hit targets were two 54px chips at the far right, so
    // clicking the outcome's NAME, which is the obvious and largest thing to click, did nothing.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    const argentina = screen.getByRole('radio', { name: /^select Argentina$/i });
    const france = screen.getByRole('radio', { name: /^select France$/i });
    expect(argentina).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(france);
    expect(france).toHaveAttribute('aria-checked', 'true');
    expect(argentina).toHaveAttribute('aria-checked', 'false');
  });

  it('marks exactly one outcome as chosen, whichever route was taken (regression)', async () => {
    // Two live rows would leave the trader guessing which one a Buy applies to. The row control
    // and the YES/NO shortcut both write the same state, so they can never disagree.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('button', { name: /^buy no on France$/i }));

    const checked = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAccessibleName(/select France/i);
  });

  it('keeps the side when only the outcome changes (positive)', async () => {
    // Picking a different outcome is not a change of mind about direction. Resetting to YES would
    // silently flip a trader who had chosen NO and was only switching which outcome to short.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.click(screen.getByRole('button', { name: /^buy no on Argentina$/i }));
    await userEvent.click(screen.getByRole('radio', { name: /^select France$/i }));

    expect(screen.getByRole('button', { name: /^buy no on France$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('does not select anything once the book closes (negative)', async () => {
    renderWithProviders(<TradeTicket market={lmsrMarket({ tradingOpen: false })} />);
    const france = screen.getByRole('radio', { name: /^select France$/i });
    expect(france).toBeDisabled();

    await userEvent.click(france);
    expect(france).toHaveAttribute('aria-checked', 'false');
  });

  it('stacks the row on a phone so the outcome name survives (MOBILE REGRESSION)', async () => {
    // The two YES/NO chips are 54px each plus their gutter — around 138px of the row that cannot
    // give way. On a 320px screen that left about 110px for a colour chip, an outcome name and a
    // percentage, so "Argentina" arrived as "A…" and the row stopped saying which outcome it was.
    // Fatal, because this row IS the choice. Below `sm` the name takes the full width and the two
    // sides sit under it as half-width targets.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    const row = screen.getByRole('radio', { name: /^select Argentina$/i }).parentElement;
    expect(row).toHaveClass('flex-col', 'sm:flex-row');

    // ...and the chips are a real target rather than a 26px sliver.
    const yes = screen.getByRole('button', { name: /^buy yes on Argentina$/i });
    expect(yes).toHaveClass('h-10', 'flex-1', 'sm:h-auto', 'sm:flex-none');
  });
});

describe('TradeTicket — funding comes first', () => {
  it('offers the setup step instead of a dead Buy button (positive)', async () => {
    // A disabled "Buy" with an explanation beside it makes the trader work out both the problem
    // and the amount. The button becomes the next action, carrying the figure.
    //
    // There is no separate "set this market up" step any more — the account is derived, so an
    // unfunded market and an under-funded one are the same state with a different number.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    accountMock.balance = 0n;
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    await typeSize('Amount to spend (USDC)', '10');

    expect(screen.getByRole('button', { name: /add .* to trade/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy privately/i })).not.toBeInTheDocument();
  });

  it('hands the shortfall to the funding panel rather than just naming it (positive)', async () => {
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    const onRequestFunds = vi.fn();
    renderWithProviders(
      <TradeTicket market={lmsrMarket({ id: MARKET_ID })} onRequestFunds={onRequestFunds} />,
    );
    accountMock.balance = 0n;
    await typeSize('Amount to spend (USDC)', '10');
    await userEvent.click(screen.getByRole('button', { name: /add .* to trade/i }));

    expect(onRequestFunds).toHaveBeenCalledTimes(1);
    // The whole cost, since the account holds nothing — and positive, so the panel above can
    // pre-fill something the trader can act on.
    expect(onRequestFunds.mock.calls[0][0]).toBeGreaterThan(0n);
  });

  it('never blocks a SALE on the market balance (negative)', async () => {
    // Selling spends shares, not collateral, and those are already with the account. Gating it on
    // a balance of zero would strand every position the moment the account ran dry.
    tradeMock.unavailable = false;
    unlinkMock.status = 'ready';
    holding(position(0, 6_000_000n));
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);

    await userEvent.click(screen.getByRole('tab', { name: /^sell$/i }));
    await userEvent.type(screen.getByLabelText('Shares to sell'), '5');

    expect(screen.getByRole('button', { name: /sell privately/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up this market/i })).not.toBeInTheDocument();
  });

  it('numbers itself as the second step (positive)', () => {
    renderWithProviders(<TradeTicket market={lmsrMarket({ id: MARKET_ID })} />);
    expect(screen.getByRole('heading', { name: /step 2 · trade/i })).toBeInTheDocument();
  });
});

describe('TradeTicket — gating', () => {
  it('blocks trading once the book closes (negative)', () => {
    renderWithProviders(<TradeTicket market={lmsrMarket({ tradingOpen: false })} />);
    expect(screen.getByRole('button', { name: /trading closed/i })).toBeDisabled();
  });

  it('prompts sign-in when anonymous (negative)', () => {
    sessionMock.status = 'anonymous';
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    expect(screen.getByRole('button', { name: /sign in to trade/i })).toBeDisabled();
  });

  it('says plainly when the deployment has no privacy layer (negative)', async () => {
    // With Unlink unavailable there is no unlock that would help, so the ticket
    // must not offer one — an unlock prompt leading nowhere reads as a bug.
    renderWithProviders(<TradeTicket market={lmsrMarket()} />);
    await userEvent.type(screen.getByLabelText('Amount to spend (USDC)'), '100');

    expect(screen.getByRole('button', { name: /private trading unavailable/i })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent(/no privacy layer configured/i);
    expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
  });
});

/**
 * Sponsored gas, when there is none.
 *
 * Numera pays the network fee on every bet, so this is the one failure that stops betting for
 * everybody at once. It is also the one the trader has no part in, which is why it gets its own
 * copy rather than borrowing the deployment-is-broken sentence next to it.
 */
describe('TradeTicket — betting paused', () => {
  it('names a spent budget and says when it comes back (positive)', () => {
    tradeMock.unavailable = false;
    tradeMock.paused = 'capped';

    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    expect(screen.getByRole('button', { name: /betting is paused/i })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent(/opens again tomorrow/i);
    // The trader's money is the first thing they will wonder about.
    expect(screen.getByRole('note')).toHaveTextContent(/nothing has been taken/i);
  });

  it('does not offer an unlock into a paused relayer (REGRESSION)', () => {
    // A passkey prompt that ends in "betting is paused" is a prompt spent on nothing.
    tradeMock.unavailable = false;
    tradeMock.needsUnlock = true;
    tradeMock.paused = 'capped';

    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    expect(screen.queryByRole('button', { name: /unlock private trading/i })).not.toBeInTheDocument();
  });

  it('lets the deeper fault speak first (negative)', () => {
    // No privacy layer means no bet whatever the relayer is doing, and saying "paused" would
    // promise it comes back tomorrow.
    tradeMock.unavailable = true;
    tradeMock.paused = 'capped';

    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    expect(screen.getByRole('button', { name: /private trading unavailable/i })).toBeDisabled();
  });

  it('says nothing when the relayer is fine (negative)', () => {
    tradeMock.unavailable = false;

    renderWithProviders(<TradeTicket market={lmsrMarket()} />);

    expect(screen.queryByRole('button', { name: /betting is paused/i })).not.toBeInTheDocument();
  });
});
