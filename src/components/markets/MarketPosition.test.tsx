import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarketPosition } from './MarketPosition';
import { renderWithProviders, makeMarket, makeOutcome } from '@/test/render';
import { endpoints } from '@/lib/api/endpoints';
import type { Position } from '@/lib/api/types';
import { predictTrade } from '@/lib/optimistic/predict';

vi.mock('@/lib/execution/account-state', () => ({
  readAccountState: vi.fn(async () => ({ balance: 25_000_000n, allowance: 0n })),
  readCollateralBalance: vi.fn(async () => 25_000_000n),
}));

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: { positions: { forAccounts: vi.fn() } },
}));

// Addresses are derived from the user's root secret now rather than read from a stored list, so
// they require an unlocked session. Stubbed here because this file is about how a position renders,
// not about derivation — `keys.test.ts` covers that, against the real curve.
vi.mock('@/lib/execution/useExecutionAccounts', () => ({
  useExecutionAccounts: () => ['0xaaaa111111111111111111111111111111111111'],
}));
let holdsCollateral = true;
vi.mock('@/lib/execution/useMarketAccount', () => ({
  useHasMarketAccount: () => holdsCollateral,
}));

// Settling moved here when the separate portfolio screen was removed. It is the step that turns a
// won bet into money, so it cannot live anywhere the product no longer has.
const claimMock = {
  claim: vi.fn(async (_position: Position) => ({ ok: true, txHash: '0xclaim' })),
  needsUnlock: false,
  unavailable: false,
  unlock: vi.fn(),
};
vi.mock('@/lib/trade/useClaimPosition', () => ({ useClaimPosition: () => claimMock }));

const forAccounts = endpoints.positions.forAccounts as unknown as ReturnType<typeof vi.fn>;

const MARKET_REF = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '0xaaaa111111111111111111111111111111111111';

function market() {
  return makeMarket({
    id: MARKET_REF,
    outcomes: [makeOutcome(0, 'Argentina', 60), makeOutcome(1, 'France', 40)],
  });
}

function position(over: Partial<Position> = {}): Position {
  return {
    marketRef: MARKET_REF,
    marketTitle: 'Argentina vs France',
    marketStatus: 'TRADING',
    engine: 'LS_LMSR',
    marketAddress: '0xbbbb111111111111111111111111111111111111',
    marketOnChainId: '7',
    collateral: '0xcccc111111111111111111111111111111111111',
    account: ACCOUNT,
    outcomeIndex: 0,
    outcomeLabel: 'Argentina',
    shares: '100000000', // 100 shares
    costBasis: '40000000', // $40
    realizedPnl: '0',
    redeemed: false,
    currentPriceWad: '600000000000000000',
    winningOutcomeId: null,
    markToMarket: '60000000', // $60
    ...over,
  };
}

beforeEach(() => {
  holdsCollateral = true;
  forAccounts.mockReset().mockResolvedValue([position()]);
});

/**
 * The optimistic half.
 *
 * A bet lands on chain seconds before our indexer writes it, and the panel used to show nothing at
 * all in that gap — at exactly the moment somebody is least sure their money went anywhere. A
 * prediction is drawn over the server's answer instead, and taken back if the bet does not happen.
 */
describe('MarketPosition, before the indexer catches up', () => {
  it('shows a first bet the server has no row for yet (positive)', async () => {
    forAccounts.mockResolvedValue([]);
    renderWithProviders(<MarketPosition market={market()} />);
    await screen.findByText(/indexing your bet/i);

    act(() => {
      predictTrade({
        account: ACCOUNT,
        marketRef: MARKET_REF,
        token: '0xcccc111111111111111111111111111111111111',
        balance: 0n,
        legs: [0],
        shares: 7_000_000n,
        money: 4_000_000n,
        side: 'buy',
        held: new Map(),
        basis: 0n,
      });
    });

    expect(await screen.findByText('7 shares')).toBeInTheDocument();
    expect(screen.getByText('Argentina')).toBeInTheDocument();
    // Named rather than silent: the figure is real, it is simply younger than the record.
    expect(screen.getByText('Settling')).toBeInTheDocument();
  });

  it('takes the prediction back when the bet fails (positive)', async () => {
    forAccounts.mockResolvedValue([]);
    renderWithProviders(<MarketPosition market={market()} />);
    await screen.findByText(/indexing your bet/i);

    let revert = () => {};
    act(() => {
      revert = predictTrade({
        account: ACCOUNT,
        marketRef: MARKET_REF,
        token: '0xcccc111111111111111111111111111111111111',
        balance: 0n,
        legs: [0],
        shares: 7_000_000n,
        money: 4_000_000n,
        side: 'buy',
        held: new Map(),
        basis: 0n,
      });
    });
    expect(await screen.findByText('7 shares')).toBeInTheDocument();

    act(() => revert());

    // Back to nothing. A position left standing after a failed bet is the worst outcome available
    // here: nothing will ever arrive to correct it, and the trader believes they hold something.
    expect(screen.queryByText('7 shares')).not.toBeInTheDocument();
    expect(screen.getByText(/indexing your bet/i)).toBeInTheDocument();
  });

  it('never conjures a position for an account this browser does not hold (negative)', async () => {
    forAccounts.mockResolvedValue([]);
    renderWithProviders(<MarketPosition market={market()} />);
    await screen.findByText(/indexing your bet/i);

    act(() => {
      predictTrade({
        account: '0xdead111111111111111111111111111111111111',
        marketRef: MARKET_REF,
        token: '0xcccc111111111111111111111111111111111111',
        balance: 0n,
        legs: [0],
        shares: 7_000_000n,
        money: 4_000_000n,
        side: 'buy',
        held: new Map(),
        basis: 0n,
      });
    });

    expect(screen.queryByText('7 shares')).not.toBeInTheDocument();
  });

  it('moves an existing holding rather than adding a second row (positive)', async () => {
    renderWithProviders(<MarketPosition market={market()} />);
    expect(await screen.findByText('100 shares')).toBeInTheDocument();

    act(() => {
      predictTrade({
        account: ACCOUNT,
        marketRef: MARKET_REF,
        token: '0xcccc111111111111111111111111111111111111',
        balance: 0n,
        legs: [0],
        shares: 25_000_000n,
        money: 15_000_000n,
        side: 'buy',
        // The confirmed figure, which is also the witness this retires on.
        held: new Map([[0, 100_000_000n]]),
        basis: 40_000_000n,
      });
    });

    expect(await screen.findByText('125 shares')).toBeInTheDocument();
    expect(screen.queryByText('100 shares')).not.toBeInTheDocument();
  });
});

describe('MarketPosition', () => {
  it('shows nothing on a market the user has never touched (negative)', () => {
    // An empty panel on every market is clutter that teaches people to skip the panel. "Untouched"
    // now means the derived account holds nothing — every market has an address, so the address
    // alone no longer distinguishes anything.
    holdsCollateral = false;
    const { container } = renderWithProviders(<MarketPosition market={market()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows shares, value and P&L for a held outcome (positive)', async () => {
    renderWithProviders(<MarketPosition market={market()} />);

    expect(await screen.findByText('Argentina')).toBeInTheDocument();
    expect(screen.getByText('100 shares')).toBeInTheDocument();
    expect(screen.getByText('Value now')).toBeInTheDocument();
    // Bought for $40, worth $60.
    expect(screen.getByText('$40')).toBeInTheDocument();
    expect(screen.getByText('+$20')).toBeInTheDocument();
  });

  it('ignores positions belonging to other markets (regression)', async () => {
    // One query serves every market page, so the filter is the only thing keeping a bet on one
    // market off another market's panel.
    forAccounts.mockResolvedValue([
      position({ marketRef: 'ffffffff-1111-4111-8111-111111111111', outcomeLabel: 'Elsewhere' }),
    ]);

    renderWithProviders(<MarketPosition market={market()} />);
    expect(await screen.findByText(/indexing your bet/i)).toBeInTheDocument();
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument();
  });

  it('says a fresh bet is still being indexed rather than showing nothing (positive)', async () => {
    // Between the trade landing and the indexer catching up, the trader has a bound account and
    // no position. Rendering an empty panel there reads as the bet having vanished.
    forAccounts.mockResolvedValue([]);

    renderWithProviders(<MarketPosition market={market()} />);
    expect(await screen.findByText(/indexing your bet/i)).toBeInTheDocument();
  });

  it('drops an outcome the user has fully sold out of (negative)', async () => {
    // A zero row is not a position, and showing one invites a sale that would revert.
    forAccounts.mockResolvedValue([position({ shares: '0', markToMarket: '0' })]);

    renderWithProviders(<MarketPosition market={market()} />);
    expect(await screen.findByText(/indexing your bet/i)).toBeInTheDocument();
    expect(screen.queryByText('Argentina')).not.toBeInTheDocument();
  });

  it('explains why a NO position appears as several lines, on request (positive)', async () => {
    forAccounts.mockResolvedValue([
      position({ outcomeIndex: 0, outcomeLabel: 'Argentina' }),
      position({ outcomeIndex: 1, outcomeLabel: 'France' }),
    ]);

    renderWithProviders(<MarketPosition market={market()} />);
    await screen.findByText('Argentina');
    // Behind the ⓘ: it explains the model rather than changing what the trader does next, and a
    // permanent paragraph under every multi-leg position is the clutter this moved.
    expect(screen.queryByText(/one share of every other outcome/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /how a position is held/i }));
    expect(screen.getByText(/one share of every other outcome/i)).toBeInTheDocument();
  });

  it('names the shielded account holding the position (PRIVACY)', async () => {
    // The unlinkable holder is the product, not a debugging detail.
    renderWithProviders(<MarketPosition market={market()} />);
    const holder = await screen.findByTitle(/shielded execution account/i);
    expect(holder).toHaveTextContent('0xaaaa');
    expect(holder).toHaveTextContent(/cannot be traced to a person/i);
  });
});

describe('MarketPosition — settlement', () => {
  const won = (over: Partial<Position> = {}) =>
    position({ marketStatus: 'RESOLVED', winningOutcomeId: 0, outcomeIndex: 0, ...over });

  beforeEach(() => {
    claimMock.claim.mockClear().mockResolvedValue({ ok: true, txHash: '0xclaim' });
    claimMock.unlock.mockClear();
    claimMock.needsUnlock = false;
    claimMock.unavailable = false;
  });

  it('offers to collect a bet that won (positive)', async () => {
    // The last step of the whole product. It used to live on a separate portfolio page; with that
    // page gone this is the only surface a settled position appears on, so if the button is not
    // here the winnings cannot be reached at all.
    forAccounts.mockResolvedValue([won()]);
    renderWithProviders(<MarketPosition market={market()} />);

    const button = await screen.findByRole('button', { name: /collect winnings/i });
    await userEvent.click(button);
    expect(claimMock.claim).toHaveBeenCalledTimes(1);
    expect(claimMock.claim.mock.calls[0][0]).toMatchObject({ outcomeIndex: 0 });
  });

  it('offers nothing on the side that lost (negative)', async () => {
    forAccounts.mockResolvedValue([
      position({ marketStatus: 'RESOLVED', winningOutcomeId: 1, outcomeIndex: 0 }),
    ]);
    renderWithProviders(<MarketPosition market={market()} />);

    await screen.findByText('Argentina');
    expect(screen.queryByRole('button', { name: /collect/i })).not.toBeInTheDocument();
  });

  it('refunds every side of an invalid market (positive)', async () => {
    // An invalid market pays everyone back, so the winning-outcome test does not apply and gating
    // on it would strand the refund.
    forAccounts.mockResolvedValue([
      position({ marketStatus: 'INVALID', winningOutcomeId: null, outcomeIndex: 0 }),
    ]);
    renderWithProviders(<MarketPosition market={market()} />);

    expect(await screen.findByRole('button', { name: /collect winnings/i })).toBeInTheDocument();
  });

  it('says so once collected, and stops offering (negative)', async () => {
    forAccounts.mockResolvedValue([won({ redeemed: true })]);
    renderWithProviders(<MarketPosition market={market()} />);

    expect(await screen.findByText('Collected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /collect winnings/i })).not.toBeInTheDocument();
  });

  it('unlocks first rather than refusing (positive)', async () => {
    // Needing the shielded key is a step, not a refusal — a disabled button here would read as
    // winnings that cannot be collected.
    claimMock.needsUnlock = true;
    forAccounts.mockResolvedValue([won()]);
    renderWithProviders(<MarketPosition market={market()} />);

    const button = await screen.findByRole('button', { name: /unlock to collect/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(claimMock.unlock).toHaveBeenCalledTimes(1);
    expect(claimMock.claim).not.toHaveBeenCalled();
  });

  it('blocks only when there is no privacy layer to claim through (negative)', async () => {
    claimMock.unavailable = true;
    forAccounts.mockResolvedValue([won()]);
    renderWithProviders(<MarketPosition market={market()} />);

    expect(await screen.findByRole('button', { name: /collect winnings/i })).toBeDisabled();
  });
});
