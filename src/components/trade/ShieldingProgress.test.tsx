import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShieldingProgress, SHIELD_STAGES, stageIndexFor } from './ShieldingProgress';
import { SETTLED_AT } from '@/components/ui/Waiting';
import { TRADE_STATUS } from '@/lib/execution/trading';

describe('stageIndexFor', () => {
  it('maps each known session status to a stage (positive)', () => {
    // The statuses are the execution layer's own constants now, not a vendor's session states.
    // Matching them exactly is what keeps the panel honest: an unrecognised status holds position
    // rather than advancing, so a drift between the two sides shows as a stalled panel, not a
    // wrong one.
    expect(stageIndexFor(TRADE_STATUS.funding)).toBe(0);
    expect(stageIndexFor(TRADE_STATUS.placing)).toBe(1);
    expect(stageIndexFor(TRADE_STATUS.closing)).toBe(1);
    expect(stageIndexFor(TRADE_STATUS.claiming)).toBe(1);
    expect(stageIndexFor(TRADE_STATUS.returning)).toBe(2);
  });

  it('refuses to guess at an unknown status (REGRESSION)', () => {
    // The vendor adds statuses without notice. Mapping an unrecognised one to
    // the last stage would tell the user their bet had settled when it had not,
    // so this must stay null and leave the panel where it was.
    expect(stageIndexFor('some_future_status')).toBeNull();
    expect(stageIndexFor('')).toBeNull();
  });

  it('never maps a failure status to a stage (negative)', () => {
    for (const status of ['failed', 'reverted', 'manual_recovery_required']) {
      expect(stageIndexFor(status)).toBeNull();
    }
  });

  it('assigns every status to exactly one stage (invariant)', () => {
    const seen = new Set<string>();
    for (const stage of SHIELD_STAGES) {
      for (const status of stage.statuses) {
        expect(seen.has(status), `${status} appears in two stages`).toBe(false);
        seen.add(status);
      }
    }
  });
});

describe('ShieldingProgress', () => {
  it('shows the mark and nothing to read (REGRESSION)', () => {
    // This panel used to carry a headline, a running clock, a four-step list with a description
    // under the active step, and two closing paragraphs. Every one of them was answering "is this
    // stuck?", and five answers to one question reads as a system apologising for itself. The arc
    // grows as the stages complete, which answers it by moving.
    const { container } = render(
      <ShieldingProgress status={TRADE_STATUS.funding} action="Buying Argentina" />,
    );

    expect(screen.getByRole('progressbar', { name: 'Buying Argentina' })).toBeInTheDocument();
    // Nothing to read on screen: the only text left is the screen-reader live region.
    const visible = Array.from(container.querySelectorAll('p'))
      .filter((el) => !el.className.includes('sr-only'))
      .map((el) => (el.textContent ?? '').trim())
      .join('');
    expect(visible).toBe('');
  });

  it('carries the stage as a number for assistive tech (a11y)', () => {
    // A screen reader cannot see an arc grow, so the fraction goes across as `aria-valuenow` too.
    const { rerender } = render(
      <ShieldingProgress status={TRADE_STATUS.funding} action="Buying Argentina" />,
    );
    const early = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));

    rerender(<ShieldingProgress status={TRADE_STATUS.returning} action="Buying Argentina" />);
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(early);
  });

  it('hands the loop over at exactly the offset the receipt opens on (REGRESSION)', () => {
    // Two regressions guarded by one number.
    //
    // First: `settled` carries no statuses — it is the state the panel is replaced by, not one it
    // reports — so counting it in the denominator capped a finished bet below its own maximum. A
    // buy, which never emits `returning`, stopped halfway and then vanished, which reads as the bet
    // having been abandoned rather than placed.
    //
    // Second, and the reason this is not simply 100: the wait stops three quarters of the way round
    // the loop because `TradeReceipt` opens on exactly that offset and shuts the last quarter. A
    // wait that ran to a full turn would make the mark jump backwards at the moment of success.
    const { rerender } = render(
      <ShieldingProgress status={TRADE_STATUS.placing} action="Buying Argentina" />,
    );
    const settled = Math.round(SETTLED_AT * 100);
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeLessThan(
      settled,
    );

    rerender(<ShieldingProgress status={TRADE_STATUS.placing} action="Buying Argentina" done />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(settled));
  });

  it('never draws past the handoff, however long it runs (invariant)', async () => {
    // The creep is asymptotic, so no amount of waiting may push it past the offset the receipt
    // takes over at.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ShieldingProgress status={TRADE_STATUS.returning} action="Buying Argentina" />);
      await act(async () => {
        vi.advanceTimersByTime(600_000);
      });
      expect(
        Number(screen.getByRole('progressbar').getAttribute('aria-valuenow')),
      ).toBeLessThanOrEqual(Math.round(SETTLED_AT * 100));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps creeping while a stage sits still (positive)', async () => {
    // A stage can legitimately hold for a minute. Without the creep the arc freezes, and a frozen
    // reading is exactly what "it looks stuck" describes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ShieldingProgress status={TRADE_STATUS.funding} action="Buying Argentina" />);
      const first = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));

      await act(async () => {
        vi.advanceTimersByTime(8_000);
      });
      expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(
        first,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces progress once, not per stage label (a11y)', () => {
    render(<ShieldingProgress status={TRADE_STATUS.placing} action="Buying Argentina" />);

    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Placing on-chain');
    // The mark is decoration and must never reach a screen reader as anything but the label.
    expect(live).not.toHaveTextContent(/[0-9a-f]{20}/);
  });

  it('keeps every stage available to a screen reader (a11y)', () => {
    // The stage list is gone from the screen, not from the product: the live region still names
    // where the operation has got to, which is the part that was ever information.
    const { rerender } = render(<ShieldingProgress status={null} action="Buying Argentina" />);
    expect(screen.getByRole('status')).toHaveTextContent(SHIELD_STAGES[0].label);

    rerender(<ShieldingProgress status={TRADE_STATUS.returning} action="Buying Argentina" />);
    expect(screen.getByRole('status')).toHaveTextContent(SHIELD_STAGES[2].label);
  });

  it('never walks backwards when a late status arrives (REGRESSION)', () => {
    // Opening a position is two operations, and the second one restarts the
    // status stream from the beginning. A panel that jumped back to step one
    // would read as the bet having failed and restarted.
    const { rerender } = render(
      <ShieldingProgress status={TRADE_STATUS.placing} action="Buying Argentina" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Placing on-chain');

    rerender(<ShieldingProgress status={TRADE_STATUS.funding} action="Buying Argentina" />);
    expect(screen.getByRole('status')).toHaveTextContent('Placing on-chain');
  });

  it('holds position on an unrecognised status (negative)', () => {
    const { rerender } = render(
      <ShieldingProgress status={TRADE_STATUS.placing} action="Buying Argentina" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Placing on-chain');

    rerender(<ShieldingProgress status="something_unrecognised" action="Buying Argentina" />);
    expect(screen.getByRole('status')).toHaveTextContent('Placing on-chain');
  });

  it('starts at the first stage before any status arrives (positive)', () => {
    render(<ShieldingProgress status={null} action="Selling Draw" />);
    expect(screen.getByRole('status')).toHaveTextContent('Shielding your stake');
    expect(screen.getByRole('progressbar', { name: 'Selling Draw' })).toBeInTheDocument();
  });
});

describe('a long wait', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('stays wordless while the wait is normal (REGRESSION)', async () => {
    render(<ShieldingProgress status={TRADE_STATUS.funding} action="Topping up" />);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.queryByText(/still going/i)).not.toBeInTheDocument();
  });

  it('breaks its silence once the wait is genuinely long (positive)', async () => {
    // The one sentence kept. Silence at four minutes is not calm — it is what makes people reload
    // mid-bet or press the button a second time, and a second bet is real money.
    render(<ShieldingProgress status={TRADE_STATUS.funding} action="Topping up" />);
    expect(screen.queryByText(/still going/i)).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    const notice = screen.getByText(/still going/i);
    expect(notice).toHaveTextContent(/nothing has been lost/i);
    expect(notice).toHaveTextContent(/do not start another/i);
  });

});
