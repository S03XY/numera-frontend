import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PriceChart } from './PriceChart';
import { renderWithProviders, makeMarket, makeOutcome } from '@/test/render';
import { endpoints } from '@/lib/api/endpoints';
import type { Candle } from '@/lib/api/types';

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: { prices: { candles: vi.fn() } },
}));

const candles = endpoints.prices.candles as unknown as ReturnType<typeof vi.fn>;

const WAD = 10n ** 18n;
const pct = (p: number) => ((WAD * BigInt(Math.round(p * 100))) / 10_000n).toString();

function candle(time: string, close: number): Candle {
  const v = pct(close);
  return { time, open: v, high: v, low: v, close: v, volume: '0' };
}

function market() {
  return makeMarket({
    outcomes: [makeOutcome(0, 'Argentina', 55), makeOutcome(1, 'France', 45)],
  });
}

beforeEach(() => {
  candles.mockReset().mockResolvedValue([]);
});

describe('PriceChart', () => {
  it('draws one line per outcome (positive)', async () => {
    candles.mockImplementation(async (_ref: string, params: { outcome?: number }) =>
      params.outcome === 0
        ? [candle('2026-08-06T10:00:00Z', 50), candle('2026-08-06T11:00:00Z', 55)]
        : [candle('2026-08-06T10:00:00Z', 50), candle('2026-08-06T11:00:00Z', 45)],
    );

    const { container } = renderWithProviders(<PriceChart market={market()} />);
    await waitFor(() => expect(container.querySelectorAll('svg path')).toHaveLength(2));
  });

  it('asks for each outcome separately, not one query for the market (regression)', async () => {
    // The endpoint takes a single `outcome`. Fetching once and hoping for every series back
    // would silently chart outcome 0 twice.
    renderWithProviders(<PriceChart market={market()} />);
    await waitFor(() => expect(candles).toHaveBeenCalledTimes(2));
    const asked = candles.mock.calls.map((c) => (c[1] as { outcome: number }).outcome).sort();
    expect(asked).toEqual([0, 1]);
  });

  it('says the market has not traded rather than drawing an empty box (negative)', async () => {
    renderWithProviders(<PriceChart market={market()} />);
    expect(await screen.findByText(/has not traded/i)).toBeInTheDocument();
  });

  it('widens the window when the default one is empty (positive)', async () => {
    // A market that last traded thirty hours ago has a history and an empty day. Reporting "has
    // not traded" over the top of it is simply wrong.
    candles.mockImplementation(async (_ref: string, params: { from?: string }) => {
      const hours = (Date.now() - Date.parse(params.from ?? '')) / 3_600_000;
      return hours > 100
        ? [candle('2026-08-04T10:00:00Z', 50), candle('2026-08-04T11:00:00Z', 60)]
        : [];
    });

    renderWithProviders(<PriceChart market={market()} />);
    expect(await screen.findByText(/quiet lately/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '1W' })).toHaveAttribute('aria-selected', 'true');
  });

  it('stops widening once the user picks a range (negative)', async () => {
    // Auto-widening must never fight a deliberate choice, or the control appears broken.
    renderWithProviders(<PriceChart market={market()} />);
    await userEvent.click(screen.getByRole('tab', { name: '1H' }));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '1H' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('tab', { name: '1W' })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the move across the window per outcome (positive)', async () => {
    candles.mockImplementation(async (_ref: string, params: { outcome?: number }) =>
      params.outcome === 0
        ? [candle('2026-08-06T10:00:00Z', 50), candle('2026-08-06T11:00:00Z', 55)]
        : [candle('2026-08-06T10:00:00Z', 50), candle('2026-08-06T11:00:00Z', 45)],
    );

    renderWithProviders(<PriceChart market={market()} />);
    expect(await screen.findByText('+5.0')).toBeInTheDocument();
    expect(screen.getByText('-5.0')).toBeInTheDocument();
  });

  it('matches its viewBox to its own width so type is never squeezed (MOBILE REGRESSION)', async () => {
    // This was a fixed 720×200 viewBox stretched to fit with `preserveAspectRatio="none"`, which
    // on a phone is a 0.4× horizontal squeeze. `vector-effect` protects the strokes; nothing
    // protects `<text>`, so every axis label and both clock readings were compressed to
    // two-fifths of their width — legible on a laptop, illegible on the device most people open a
    // market on. A viewBox that equals the rendered width is 1:1 at every size.
    candles.mockResolvedValue([
      candle('2026-08-06T10:00:00Z', 50),
      candle('2026-08-06T11:00:00Z', 55),
    ]);

    const { container } = renderWithProviders(<PriceChart market={market()} />);
    const svg = await screen.findByRole('img', { name: /price history/i });

    const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    // jsdom measures 0, so the chart falls back to its desktop box rather than collapsing the
    // plot to a single column — which is the behaviour that keeps a server render usable too.
    expect(w).toBe(720);
    expect(svg).toHaveStyle({ height: `${h}px` });

    // And it must not eat vertical scrolling: `touch-action: none` on a full-width band means a
    // thumb starting its swipe on the chart moves nothing, and the page reads as frozen.
    expect(container.querySelector('svg')).toHaveClass('touch-pan-y');
  });

  it('describes itself for a screen reader rather than being a bare graphic (a11y)', async () => {
    candles.mockResolvedValue([
      candle('2026-08-06T10:00:00Z', 50),
      candle('2026-08-06T11:00:00Z', 55),
    ]);

    renderWithProviders(<PriceChart market={market()} />);
    const chart = await screen.findByRole('img', { name: /price history/i });
    expect(chart).toHaveAccessibleName(/55.0 percent/i);
  });
});
