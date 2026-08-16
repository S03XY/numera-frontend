import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Bar, BarStack, RowStack, SETTLED_AT, SettledMark, TraceMark, Waiting, useDelayedFlag } from './Waiting';

describe('TraceMark', () => {
  it('reports how far round the loop it has drawn (a11y)', () => {
    render(<TraceMark progress={0.4} label="Placing your bet" />);
    const bar = screen.getByRole('progressbar', { name: 'Placing your bet' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('is a status, not a progress bar, when there is no progress to report (positive)', () => {
    // Work whose stages we cannot observe must not claim a number. Announcing "0 percent" for an
    // operation that is simply unobservable is a worse lie than saying nothing.
    render(<TraceMark label="Working" />);
    expect(screen.getByRole('status', { name: 'Working' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('clamps a caller that goes out of range (negative)', () => {
    const { rerender } = render(<TraceMark progress={-3} label="Working" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    rerender(<TraceMark progress={9} label="Working" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('hides the drawing from assistive tech (a11y)', () => {
    // A square with a light going round it carries nothing a screen reader can use. The role and
    // label on the wrapper are the whole of the information.
    const { container } = render(<TraceMark progress={0.5} label="Placing your bet" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('');
  });
});

describe('the handoff from the wait to the receipt', () => {
  /** The perimeter both halves are drawn on, in SVG user units. */
  const PERIMETER = 128;

  const globalsCss = fs.readFileSync(
    path.join(process.cwd(), 'src/app/globals.css'),
    'utf8',
  );

  /** The `stroke-dashoffset` declared on a rule in `globals.css`. */
  function declaredOffset(selector: string): number {
    const block = globalsCss.split(selector)[1] ?? '';
    const match = /stroke-dashoffset:\s*(-?[\d.]+)/.exec(block.slice(0, 240));
    expect(match, `${selector} declares no stroke-dashoffset`).not.toBeNull();
    return Number(match![1]);
  }

  it('leaves the arc exactly where the receipt picks it up (REGRESSION)', () => {
    // The one number that makes a placed bet read as a single gesture rather than two animations.
    //
    // `ShieldingProgress` scales into SETTLED_AT, and `.circuit-arc` hardcodes the offset it opens
    // on. They live in different files and different languages, so nothing but this test stops them
    // drifting — and the failure is not subtle: the mark visibly jumps backwards at the exact
    // moment the trader is told their bet went through.
    const { container } = render(<TraceMark progress={SETTLED_AT} label="Placing your bet" />);
    const arc = container.querySelector('.trace-arc');

    const drawn = Number((arc as HTMLElement).style.strokeDashoffset);
    expect(drawn).toBeCloseTo(PERIMETER * (1 - SETTLED_AT), 6);
    expect(drawn).toBeCloseTo(declaredOffset('.circuit-arc'), 6);
  });

  it('starts the spark from the same place as the arc (invariant)', () => {
    // The spark runs the quarter the arc is closing. Starting it anywhere else would light a
    // stretch of loop that was already drawn.
    expect(declaredOffset('.circuit-spark')).toBeCloseTo(declaredOffset('.circuit-arc'), 6);
  });

  it('draws nothing a screen reader has to hear (a11y)', () => {
    // Hidden at the wrapper rather than per drawing, so the lock inside it is covered too.
    const { container } = render(<SettledMark />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    // The panel around it says "Bet placed privately" in words, to everyone.
    expect(container.textContent).toBe('');
  });

  it('lights the lock rather than leaving it dim (REGRESSION)', () => {
    // The lock going from ink to accent is the whole of the visual confirmation. Every other part
    // of this animation is a flourish around it, and a receipt whose lock stayed grey would be
    // saying the opposite of what happened.
    const { container } = render(<SettledMark />);
    expect(container.querySelector('.circuit-lock')).not.toBeNull();
  });
});

describe('placeholders', () => {
  it('holds the space with nothing to read (REGRESSION)', () => {
    // The whole point of the change. What was here rendered scrambling hex, and at the lengths it
    // was used at nobody read it as ciphertext: they read a paragraph of nonsense and kept trying
    // to parse it. A placeholder that carries any text at all reopens that.
    const { container } = render(<Bar chars={9} />);
    const bar = container.firstElementChild as HTMLElement;

    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar.textContent).toBe('');
    // Sized in `ch`, so one component covers a 34px balance and an 11px table cell.
    expect(bar.style.width).toBe('9ch');
  });

  it('gives a block one label rather than one per line (a11y)', () => {
    render(<BarStack lines={[30, 24, 18]} label="Loading the book" />);
    expect(screen.getByRole('status', { name: 'Loading the book' })).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('gives a table of rows one label too (a11y)', () => {
    render(<RowStack rows={3} label="Loading disputes" />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Loading disputes' })).toBeInTheDocument();
  });
});

describe('Waiting', () => {
  it('is wordless on screen and named for everyone else (a11y)', () => {
    const { container } = render(<Waiting progress={0.3} label="Shielding your deposit" />);
    expect(
      screen.getByRole('progressbar', { name: 'Shielding your deposit' }),
    ).toBeInTheDocument();
    expect(container.textContent).toBe('');
  });
});

describe('useDelayedFlag', () => {
  it('withholds the placeholder until the wait is worth explaining (positive)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useDelayedFlag(true, 180));
      expect(result.current).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops it the instant the data lands (REGRESSION)', async () => {
    // Asymmetric on purpose. Holding a placeholder open to satisfy a minimum duration, once the
    // data is already here, is just a slower app.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 180), {
        initialProps: { active: true },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current).toBe(true);

      rerender({ active: false });
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows for a read that resolves inside the delay (negative)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 180), {
        initialProps: { active: true },
      });
      await act(async () => {
        vi.advanceTimersByTime(40);
      });
      rerender({ active: false });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
