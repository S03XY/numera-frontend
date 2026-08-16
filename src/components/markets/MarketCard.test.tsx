import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketCard, MarketCardSkeleton, MarketStatus } from './MarketCard';
import { Distribution, OutcomeRow, outcomeVar } from './Outcomes';
import { makeMarket, makeOutcome } from '@/test/render';

describe('outcome colour ramp', () => {
  it('gives index 0 the house crimson and steps down from there', () => {
    expect(outcomeVar(0)).toBe('var(--o-0)');
    expect(outcomeVar(3)).toBe('var(--o-3)');
  });

  it('clamps beyond the ramp rather than producing an undefined variable (negative)', () => {
    expect(outcomeVar(9)).toBe('var(--o-4)');
  });
});

describe('Distribution', () => {
  it('sizes each segment by probability and labels the whole bar', () => {
    const { container } = render(
      <Distribution outcomes={[makeOutcome(0, 'Argentina', 60), makeOutcome(1, 'France', 40)]} />,
    );
    const segs = container.querySelectorAll('.dist-seg');
    expect(segs).toHaveLength(2);
    expect((segs[0] as HTMLElement).style.width).toBe('60%');
    expect((segs[1] as HTMLElement).style.width).toBe('40%');
    expect(screen.getByRole('img')).toHaveAccessibleName(/Argentina/);
  });

  it('renders an inert bar when every price is missing (negative)', () => {
    const blank = { ...makeOutcome(0, 'Yes', 0), priceWad: null };
    const { container } = render(<Distribution outcomes={[blank]} />);
    expect(container.querySelectorAll('.dist-seg')).toHaveLength(0);
  });
});

describe('OutcomeRow', () => {
  it('shows the label and probability', () => {
    render(<OutcomeRow outcome={makeOutcome(0, 'Argentina', 60)} />);
    expect(screen.getByText('Argentina')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
  });

  it('falls back to a positional name when a label is missing (negative)', () => {
    render(<OutcomeRow outcome={makeOutcome(2, '', 25)} />);
    expect(screen.getByText('Outcome 3')).toBeInTheDocument();
  });

  it('marks the winning outcome', () => {
    render(<OutcomeRow outcome={makeOutcome(0, 'Argentina', 100)} isWinner />);
    expect(screen.getByText('Won')).toBeInTheDocument();
  });
});

describe('MarketStatus', () => {
  it('counts down in digits while trading is open', () => {
    // A day or more out, so the slow clock draws it: days plus a zero-padded hh:mm:ss.
    render(
      <MarketStatus
        market={makeMarket({ closeTime: new Date(Date.now() + 30 * 3_600_000).toISOString() })}
      />,
    );
    expect(screen.getByText(/^1d \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('drops the days once there are none, rather than padding them (positive)', () => {
    render(
      <MarketStatus
        market={makeMarket({ closeTime: new Date(Date.now() + 90 * 60_000).toISOString() })}
      />,
    );
    expect(screen.getByText(/^01:(29|30):\d{2}$/)).toBeInTheDocument();
  });

  it('replaces the countdown once the book closes (negative)', () => {
    render(<MarketStatus market={makeMarket({ tradingOpen: false })} />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('counts down to the open, not the close, on a scheduled market (positive)', () => {
    /*
      "Closed" on a market that opens on Friday reads as "you missed it", and it is the opposite.
      Worse, a countdown to the *close* would invite a bet the engine reverts with
      `MarketNotOpenYet` — a condition the trader was never shown.
    */
    render(
      <MarketStatus
        market={makeMarket({
          tradingOpen: false,
          notOpenYet: true,
          startTime: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          closeTime: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        })}
        alwaysTicking
      />,
    );

    expect(screen.getByText('Opens')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    // Two hours to the open, not forty-eight to the close.
    expect(screen.getByText(/^0?[12]:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('says nothing about opening once a market is already open (negative)', () => {
    // Every market has a start time — the engine substitutes the creation block when a creator
    // does not name one — so an unguarded row would read "Opens" on every market ever made.
    render(<MarketStatus market={makeMarket()} />);

    expect(screen.queryByText('Opens')).not.toBeInTheDocument();
  });

  it('prefers the settled seal over the opening clock (REGRESSION)', () => {
    // A resolved market is not "opening", whatever its timestamps say.
    render(
      <MarketStatus
        market={makeMarket({
          status: 'RESOLVED',
          tradingOpen: false,
          notOpenYet: true,
          startTime: new Date(Date.now() + 3_600_000).toISOString(),
        })}
      />,
    );

    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.queryByText('Opens')).not.toBeInTheDocument();
  });

  it('shows settled and void states', () => {
    const { rerender } = render(
      <MarketStatus market={makeMarket({ status: 'RESOLVED', tradingOpen: false })} />,
    );
    expect(screen.getByText('Settled')).toBeInTheDocument();

    rerender(<MarketStatus market={makeMarket({ status: 'INVALID', tradingOpen: false })} />);
    expect(screen.getByText('Void')).toBeInTheDocument();
  });

  it('flags the final hour in the accent colour, down to mm:ss', () => {
    // Inside the hour the hours are dropped too, so what is left is exactly the part that matters.
    render(
      <MarketStatus
        market={makeMarket({ closeTime: new Date(Date.now() + 20 * 60_000).toISOString() })}
      />,
    );
    expect(screen.getByText(/^(19|20):\d{2}$/)).toHaveClass('text-accent-bright');
  });

  /**
   * The board can hold sixty of these. A market closing next week must not subscribe to the
   * one-second clock, or the whole grid re-renders every second forever for digits nobody needs.
   */
  it('leaves a distant market off the fast clock (efficiency)', () => {
    // A minute past the boundary, not exactly on it. The target is computed here and the clock
    // snapshots `Date.now()` a moment later, so an exact five days floors to `4d 23:59:59` often
    // enough to fail one run in three. Every assertion in this block is offset for the same reason.
    const far = makeMarket({ closeTime: new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString() });
    const { container } = render(<MarketStatus market={far} />);
    expect(container.textContent).toMatch(/^5d /);
    expect(container.querySelector('.text-accent-bright')).toBeNull();
  });
});

describe('MarketCard', () => {
  it('renders the title, outcomes and pool, and links to the market (positive)', () => {
    render(<MarketCard market={makeMarket()} index={0} />);

    expect(screen.getByRole('heading', { name: 'Argentina vs France' })).toBeInTheDocument();
    expect(screen.getByText('Argentina')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText(/1\.5K pool/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/markets/11111111-1111-4111-8111-111111111111',
    );
  });

  it('numbers each card as a folio entry', () => {
    render(<MarketCard market={makeMarket()} index={4} />);
    expect(screen.getByText('005')).toBeInTheDocument();
  });

  it('collapses outcomes beyond the third into a count', () => {
    render(
      <MarketCard
        market={makeMarket({
          outcomes: [
            makeOutcome(0, 'A', 30),
            makeOutcome(1, 'B', 30),
            makeOutcome(2, 'C', 20),
            makeOutcome(3, 'D', 10),
            makeOutcome(4, 'E', 10),
          ],
        })}
      />,
    );
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    expect(screen.queryByText('D')).not.toBeInTheDocument();
  });

  it('falls back to a placeholder title rather than rendering an empty heading (negative)', () => {
    render(<MarketCard market={makeMarket({ title: '' })} />);
    expect(screen.getByRole('heading', { name: 'Untitled market' })).toBeInTheDocument();
  });

  it('marks the winner on a settled market', () => {
    render(
      <MarketCard
        market={makeMarket({ status: 'RESOLVED', tradingOpen: false, winningOutcomeId: 0 })}
      />,
    );
    expect(screen.getByText('Won')).toBeInTheDocument();
  });

  it('labels every market as live-priced (positive)', () => {
    // There is one engine now. The card used to say "Pooled" for parimutuel books, which no
    // longer exist — every market on the platform quotes continuously and can be exited.
    render(<MarketCard market={makeMarket()} />);
    expect(screen.getByText('Live pricing')).toBeInTheDocument();
    expect(screen.queryByText('Pooled')).not.toBeInTheDocument();
  });

  it('offers one loading label and hides the bars from assistive tech', () => {
    // The tile carries no information a screen reader can use — it is the card's own geometry,
    // held open so the grid does not jump when the markets land. One label, and every bar hidden
    // behind it. The previous placeholder was scrambling ciphertext, and announcing a stream of
    // shifting hex would have been actively hostile.
    const { container } = render(<MarketCardSkeleton />);

    expect(screen.getByRole('status', { name: /loading market/i })).toBeInTheDocument();
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBeGreaterThan(3);
    // Placeholders, not content: nothing here may carry text a reader could try to make sense of.
    for (const node of bars) expect(node.textContent).toBe('');
  });
});
