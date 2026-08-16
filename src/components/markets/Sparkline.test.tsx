import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline, sparklineChange } from './Sparkline';

const WAD = 10n ** 18n;
const pct = (p: number) => ((WAD * BigInt(Math.round(p * 100))) / 10_000n).toString();

describe('sparklineChange', () => {
  it('measures the move across the window in points (positive)', () => {
    expect(sparklineChange([pct(40), pct(52)])).toBeCloseTo(12, 5);
    expect(sparklineChange([pct(60), pct(55)])).toBeCloseTo(-5, 5);
  });

  it('has no answer for a series that cannot move (negative)', () => {
    // One sample has no direction, and reporting 0 would claim the market was flat when it has
    // simply only traded once.
    expect(sparklineChange([pct(50)])).toBeNull();
    expect(sparklineChange([])).toBeNull();
    expect(sparklineChange(undefined)).toBeNull();
  });
});

describe('Sparkline', () => {
  it('draws a path through the series (positive)', () => {
    const { container } = render(<Sparkline points={[pct(40), pct(45), pct(52)]} />);
    const path = container.querySelector('path');
    expect(path).toBeInTheDocument();
    expect(path?.getAttribute('d')?.startsWith('M')).toBe(true);
  });

  it('reserves its space instead of collapsing when there is nothing to draw (regression)', () => {
    // A card whose footer changes height when history arrives makes the whole board jump.
    const { container } = render(<Sparkline points={[pct(50)]} />);
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveStyle({ width: '64px', height: '18px' });
  });

  it('colours by direction over the window, not by the last step (positive)', () => {
    const up = render(<Sparkline points={[pct(40), pct(60), pct(55)]} />);
    expect(up.container.querySelector('path')).toHaveAttribute('stroke', 'var(--pos)');

    const down = render(<Sparkline points={[pct(60), pct(40), pct(45)]} />);
    expect(down.container.querySelector('path')).toHaveAttribute('stroke', 'var(--neg)');
  });

  it('survives a flat series without dividing by zero (negative)', () => {
    const { container } = render(<Sparkline points={[pct(50), pct(50), pct(50)]} />);
    expect(container.querySelector('path')?.getAttribute('d')).not.toMatch(/NaN/);
  });

  it('is hidden from screen readers — the figure beside it carries the meaning (a11y)', () => {
    const { container } = render(<Sparkline points={[pct(40), pct(52)]} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
