import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ResolutionPanel } from './ResolutionPanel';
import { renderWithProviders, makeMarket } from '@/test/render';
import type { Market, Resolution } from '@/lib/api/types';

/**
 * The panel a trader uses to take part in settling a market.
 *
 * What is being defended here is mostly *not* the happy path. It is the small set of ways this
 * screen could quietly mislead somebody into staking money:
 *
 *  - offering a challenge after the window has closed,
 *  - hiding that a proposal carries no stake behind it,
 *  - letting a disputer re-assert the outcome they are disputing,
 *  - and treating outcome 0 as "nothing chosen", which would disable the button forever on the
 *    first outcome of every market.
 */

const propose = vi.fn(async () => ({ ok: true as const, hash: '0xhash', account: '0xacct' }));
const dispute = vi.fn(async () => ({ ok: true as const, hash: '0xhash', account: '0xacct' }));

vi.mock('@/lib/execution/useResolution', () => ({
  useResolutionActions: () => ({ propose, dispute, busy: false, available: true }),
  resolutionUnavailableReason: () => null,
}));

const TERMS = {
  available: true as const,
  resolver: '0xresolver',
  bond: '25000000', // 25 USDC
  bondHuman: '25',
  fee: '1000000', // 1 USDC
  feeHuman: '1',
  reward: '4000000', // 4 USDC
  rewardHuman: '4',
  disputeWindowSeconds: 21_600,
  rewardPool: '5000000000',
  rewardPoolHuman: '5000',
};

const terms = vi.fn(() => ({ data: TERMS, isLoading: false }));
vi.mock('@/lib/hooks/useMarkets', () => ({
  useResolutionTerms: () => terms(),
}));

/**
 * Unknown by default, which is what the panel sees when nothing is unlocked. Tests that care about
 * the money set it explicitly.
 */
const balance = vi.fn(() => ({
  address: null as string | null,
  balance: 0n,
  allowance: 0n,
  unset: true,
  isPending: false,
  isError: false,
}));
vi.mock('@/lib/execution/useMarketAccount', () => ({
  useMarketAccountBalance: () => {
    const state = balance();
    /*
      The hook separates what is drawn from what is decided on: `balance` may include a deposit
      that has not landed, `settledBalance` never does. Every assertion in this file is about a
      decision — can this stake be covered, is the trade affordable — so the two are the same
      figure here, and a test that wants them to differ should say so explicitly.
    */
    return { settledBalance: state.balance, pending: false, ...state };
  },
}));

/** The panel's explanation is behind the heading's ⓘ, so open it before reading it. */
function expandDetail(): void {
  fireEvent.click(
    screen
      .getAllByRole('button')
      .filter((b) => /how this market settles/i.test(b.getAttribute('aria-label') ?? ''))[0],
  );
}

function actions(): HTMLElement[] {
  return screen
    .queryAllByRole('button')
    .filter((b) => !/how this market settles/i.test(b.getAttribute('aria-label') ?? ''));
}

function button(name: RegExp): HTMLElement {
  return actions().find((b) => name.test(b.textContent ?? ''))!;
}

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    phase: 'PROPOSED',
    proposedOutcome: 0,
    proposer: '0x1111111111111111111111111111111111111111',
    bonded: true,
    bond: '25000000',
    disputeDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    disputable: true,
    finalizable: false,
    disputer: null,
    counterOutcome: null,
    disputerBond: null,
    arbitrationDeadline: null,
    route: null,
    settledOutcome: null,
    reward: null,
    forfeited: null,
    loser: null,
    settledAt: null,
    ...over,
  };
}

const closed = (over: Partial<Market> = {}) => makeMarket({ tradingOpen: false, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  terms.mockReturnValue({ data: TERMS, isLoading: false });
  balance.mockReturnValue({
    address: null,
    balance: 0n,
    allowance: 0n,
    unset: true,
    isPending: false,
    isError: false,
  });
});

describe('ResolutionPanel', () => {
  it('stays hidden while the market is still trading (negative)', () => {
    const { container } = renderWithProviders(<ResolutionPanel market={makeMarket()} />);
    expect(container.querySelector('section')).toBeNull();
  });

  // ---------------------------------------------------------------- proposing

  it('offers a trader the chance to propose once the book closes (positive)', () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);

    expect(screen.getByText('Awaiting a result')).toBeInTheDocument();
    expect(button(/choose a result first/i)).toBeDisabled();
    // Both outcomes, plus voiding.
    expect(button(/^Argentina$/)).toBeInTheDocument();
    expect(button(/^France$/)).toBeInTheDocument();
    expect(button(/void/i)).toBeInTheDocument();
  });

  it('quotes the stake, the fee and what being right pays before anything is signed', () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);

    expect(screen.getByText('Stake')).toBeInTheDocument();
    expect(screen.getByText('Fee')).toBeInTheDocument();
    expect(screen.getByText('Paid if unchallenged')).toBeInTheDocument();
    expect(screen.getByText('6 hours')).toBeInTheDocument();
  });

  it('stakes the bond plus the fee on the chosen outcome (positive)', async () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^France$/));
    fireEvent.click(button(/propose and stake/i));

    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    expect(propose).toHaveBeenCalledWith({
      marketId: 1n,
      outcomeId: 1,
      // 25 + 1: the approval has to cover the fee too, or the transfer reverts for one USDC.
      stake: 26_000_000n,
    });
  });

  /**
   * Outcome 0 is falsy. A truthiness check on the selection would leave the first outcome of every
   * market permanently unselectable, which is the single most likely way to break this form.
   */
  it('treats outcome zero as a real choice rather than as nothing (regression)', async () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^Argentina$/));
    expect(button(/propose and stake/i)).not.toBeDisabled();

    fireEvent.click(button(/propose and stake/i));
    await waitFor(() => expect(propose).toHaveBeenCalledWith(expect.objectContaining({ outcomeId: 0 })));
  });

  it('sends null rather than an index when proposing a void (regression)', async () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/void/i));
    fireEvent.click(button(/propose and stake/i));

    await waitFor(() =>
      expect(propose).toHaveBeenCalledWith(expect.objectContaining({ outcomeId: null })),
    );
  });

  it('cannot propose while the terms are unknown (negative)', () => {
    terms.mockReturnValue({ data: { available: false }, isLoading: false } as never);
    renderWithProviders(<ResolutionPanel market={closed()} />);

    // A choice is made, so the only thing still blocking is the missing quote. Nothing to quote
    // means nothing to stake against, and the action stays shut rather than signing an approval
    // for an amount nobody has checked.
    fireEvent.click(button(/^France$/));
    expect(button(/propose/i)).toBeDisabled();
    expect(screen.queryByText('Stake')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------- disputing

  it('shows the standing proposal and offers a challenge (positive)', () => {
    renderWithProviders(<ResolutionPanel market={closed({ resolution: resolution() })} />);

    expect(screen.getByText('Result proposed')).toBeInTheDocument();
    expect(screen.getByText('Proposed result')).toBeInTheDocument();
    // The action reads as a prompt until an answer is chosen, then as the stake it will place.
    expect(button(/choose what the answer is/i)).toBeDisabled();
    fireEvent.click(button(/^France$/));
    expect(button(/dispute and stake/i)).not.toBeDisabled();
  });

  /**
   * A disputer must name a *different* answer. Offering the proposed one would let somebody stake
   * against a claim while asserting the same claim, which the contract rejects — after they have
   * signed and we have paid for the gas.
   */
  it('excludes the proposed outcome from the challenge choices (regression)', () => {
    renderWithProviders(
      <ResolutionPanel market={closed({ resolution: resolution({ proposedOutcome: 0 }) })} />,
    );

    expect(actions().some((b) => /^Argentina$/.test(b.textContent ?? ''))).toBe(false);
    expect(actions().some((b) => /^France$/.test(b.textContent ?? ''))).toBe(true);
  });

  it('matches the proposer stake rather than re-pricing it (regression)', async () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({ resolution: resolution({ bond: '90000000', bonded: true }) })}
      />,
    );

    fireEvent.click(button(/^France$/));
    fireEvent.click(button(/dispute and stake/i));

    // 90 matched from the proposal, not the 25 the live terms quote — neither side can be outspent.
    await waitFor(() =>
      expect(dispute).toHaveBeenCalledWith({
        marketId: 1n,
        counterOutcomeId: 1,
        stake: 91_000_000n,
      }),
    );
  });

  /** An operator proposal stakes nothing, so a challenge has nothing to match and prices afresh. */
  it('prices a challenge to a bond-free proposal from the live terms', async () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({ resolution: resolution({ bonded: false, bond: '0' }) })}
      />,
    );

    expect(screen.getByText(/operator, without a stake/i)).toBeInTheDocument();

    fireEvent.click(button(/^France$/));
    fireEvent.click(button(/dispute and stake/i));
    await waitFor(() =>
      expect(dispute).toHaveBeenCalledWith(expect.objectContaining({ stake: 26_000_000n })),
    );
  });

  /**
   * The window closing is the whole point of the mechanism. Still offering the button after it has
   * passed invites somebody to sign a stake the chain will refuse.
   */
  it('withdraws the challenge once the window has passed (negative)', () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({ resolution: resolution({ disputable: false, finalizable: true }) })}
      />,
    );

    expect(screen.getByText('Ready to settle')).toBeInTheDocument();
    expect(actions().some((b) => /dispute/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('offers nothing while a dispute is with the quorum (negative)', () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({
          resolution: resolution({
            phase: 'DISPUTED',
            disputer: '0x2222222222222222222222222222222222222222',
            counterOutcome: 1,
            disputerBond: '25000000',
          }),
        })}
      />,
    );

    expect(screen.getByText('Disputed')).toBeInTheDocument();
    expect(screen.getByText('Says the answer is')).toBeInTheDocument();
    expect(actions()).toHaveLength(0);
  });

  // ----------------------------------------------------------------- settled

  it('names the winning outcome and how it was decided once settled', () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({
          status: 'RESOLVED',
          winningOutcomeId: 0,
          resolution: resolution({ phase: 'SETTLED', route: 'ARBITRATED', settledOutcome: 0 }),
        })}
      />,
    );

    expect(screen.getByText('Settled')).toBeInTheDocument();
    // The answer, at the size of an answer. It used to be a `Datum` row the same weight as
    // "Spread" two panels up, which is the wrong rank for the only thing anybody opens a closed
    // market to read.
    expect(screen.getByLabelText(/settled on Argentina/i)).toBeInTheDocument();
    expect(screen.getByText(/disputed the proposed result/i)).toBeInTheDocument();
    expect(actions()).toHaveLength(0);
  });

  it('names a voided market explicitly rather than showing an outcome index', () => {
    renderWithProviders(
      <ResolutionPanel market={closed({ status: 'INVALID', winningOutcomeId: null })} />,
    );

    expect(screen.getByText('Voided')).toBeInTheDocument();
    // No outcome index and no invented winner: a void market has no answer, and the thing a
    // holder needs to know is that the money comes back.
    expect(screen.getByLabelText(/voided and every trader is refunded/i)).toBeInTheDocument();
    expect(screen.getByText(/gets back what they put in/i)).toBeInTheDocument();
  });

  it('reports a forfeited stake and the trading ban together (positive)', () => {
    renderWithProviders(
      <ResolutionPanel
        market={closed({
          status: 'RESOLVED',
          winningOutcomeId: 1,
          resolution: resolution({
            phase: 'SETTLED',
            route: 'ARBITRATED',
            settledOutcome: 1,
            loser: '0x3333333333333333333333333333333333333333',
            forfeited: '25000000',
          }),
        })}
      />,
    );

    expect(screen.getByText(/barred from trading/i)).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ copy

  it('states the privacy claim where a trader will look for it', () => {
    renderWithProviders(<ResolutionPanel market={closed()} />);
    expandDetail();

    expect(screen.getByText(/reveals nothing about which side you hold/i)).toBeInTheDocument();
    // And the honest limit of the operator's bond-free path, rather than only its convenience.
    expect(screen.getByText(/never final/i)).toBeInTheDocument();
  });
});

/**
 * What happens when the shielded account cannot cover the bond.
 *
 * This is the failure a real proposer hits first, and it used to be the worst-explained thing in
 * the product: the chain reverted `ERC20InsufficientBalance`, the relayer decoded it correctly,
 * logged it, threw the detail away, and the panel told the proposer that somebody had probably got
 * there first. Every check below exists so that sentence can never come back.
 */
describe('staking against an account that cannot cover it', () => {
  it('refuses before anything is signed, and names the shortfall (REGRESSION)', () => {
    // 10 USDC held against a 26 USDC stake.
    balance.mockReturnValue({
      address: '0xacct',
      balance: 10_000_000n,
      allowance: 0n,
      unset: false,
      isPending: false,
      isError: false,
    });
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^France$/));
    const action = button(/add .* to propose/i);
    expect(action).toBeDisabled();
    // The number that matters is what is missing, not what is held, and it carries cents: this is
    // an instruction to top up, and "Add $16" when the shortfall is $16.01 is advice that fails.
    expect(action).toHaveTextContent('$16.00');
    expect(screen.getByText(/short of the stake/i)).toBeInTheDocument();
  });

  it('never signs when it cannot cover it (REGRESSION)', () => {
    balance.mockReturnValue({
      address: '0xacct',
      balance: 0n,
      allowance: 0n,
      unset: false,
      isPending: false,
      isError: false,
    });
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^France$/));
    fireEvent.click(button(/add .* to propose/i));
    expect(propose).not.toHaveBeenCalled();
  });

  /**
   * Fails open, deliberately. A balance we cannot read must never block a proposal that would have
   * worked — the relayer simulates before it broadcasts, so the chain is still the backstop.
   */
  it('lets the proposal through when the balance is unknown (negative)', () => {
    balance.mockReturnValue({
      address: null,
      balance: 0n,
      allowance: 0n,
      unset: true,
      isPending: false,
      isError: false,
    });
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^France$/));
    expect(button(/propose and stake/i)).not.toBeDisabled();
  });

  it('allows exactly enough (boundary)', () => {
    balance.mockReturnValue({
      address: '0xacct',
      balance: 26_000_000n, // bond 25 + fee 1
      allowance: 0n,
      unset: false,
      isPending: false,
      isError: false,
    });
    renderWithProviders(<ResolutionPanel market={closed()} />);

    fireEvent.click(button(/^France$/));
    expect(button(/propose and stake/i)).not.toBeDisabled();
  });
});
