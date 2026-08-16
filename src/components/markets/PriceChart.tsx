'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { wadToPercent } from '@/lib/format';
import { CHART_RANGES, useMarketCandles, type ChartRange, type OutcomeSeries } from '@/lib/hooks/useMarkets';
import type { Market } from '@/lib/api/types';
import { Folio, SectionHead } from '@/components/ui/primitives';
import { outcomeVar } from './Outcomes';

/**
 * How the odds moved.
 *
 * The market page could say what a price *is* and who traded, but never which way it had been
 * going — which is the question a trader is actually there to ask. The candles endpoint and its
 * whole TimescaleDB backing existed and nothing read them.
 *
 * Hand-drawn SVG rather than a charting library: the house is one hue, hairlines and zero radius,
 * and every library ships a look that has to be fought back to that. This is ~150 lines, has no
 * bundle cost, and reads colour straight from the theme tokens so it re-themes with everything
 * else.
 */

/**
 * The drawing box, in real pixels — measured, not assumed.
 *
 * This used to be a fixed 720×200 viewBox stretched to fit with `preserveAspectRatio="none"`, and
 * on a phone that is a 0.4× horizontal squeeze. `vector-effect` protects the strokes from it;
 * nothing protects `<text>`, so every axis label and both clock readings were compressed to
 * two-fifths of their width — legible on a laptop, illegible on the device most people open a
 * market on.
 *
 * Matching the viewBox to the rendered width instead makes the scale exactly 1:1 at every size, so
 * the type is never distorted and a hairline is a hairline. The cost is one ResizeObserver.
 */
const W_FALLBACK = 720;

/** Below this the chart is short and its right-hand axis gutter narrows. */
const COMPACT_WIDTH = 480;

interface Geometry {
  w: number;
  h: number;
  pad: { top: number; right: number; bottom: number; left: number };
  plot: { w: number; h: number };
}

function geometry(width: number): Geometry {
  const compact = width < COMPACT_WIDTH;
  const h = compact ? 152 : 200;
  // The gutter only has to hold "100%" at 9px mono. 44 was drawn for a 720-wide box; on a phone
  // that is a sixth of the plot given away to four characters.
  const pad = { top: 10, right: compact ? 28 : 44, bottom: 18, left: 0 };
  return {
    w: width,
    h,
    pad,
    plot: { w: Math.max(1, width - pad.left - pad.right), h: h - pad.top - pad.bottom },
  };
}

/**
 * The element's rendered width, tracked as it changes.
 *
 * Falls back to {@link W_FALLBACK} rather than to whatever `getBoundingClientRect` says when the
 * answer is zero — which is every server render and every jsdom test, where a measured 0 would
 * collapse the plot to a single column.
 */
function useMeasuredWidth(fallback: number) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(fallback);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => {
      const measured = Math.round(node.getBoundingClientRect().width);
      setWidth(measured > 0 ? measured : fallback);
    };
    measure();

    // Not every environment has it — jsdom does not, and a chart is not worth throwing over.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fallback]);

  return [ref, width] as const;
}

/**
 * Smallest probability span the y-axis will show, in points.
 *
 * A market that sat between 49% and 52% all day is a flat line on a 0–100 axis, which hides the
 * only thing that happened. Auto-scaling alone has the opposite failure — a 0.2pp drift rendered
 * as a mountain range. A floor of ten points is the compromise, and the axis is labelled with its
 * real bounds so the scale is never implied.
 */
const MIN_SPAN = 10;

interface Point {
  t: number;
  pct: number;
}

function toPoints(series: OutcomeSeries): Point[] {
  return series.candles
    .map((c) => ({ t: Date.parse(c.time), pct: wadToPercent(c.close, 2) ?? 0 }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

interface Bounds {
  t0: number;
  t1: number;
  lo: number;
  hi: number;
}

function bounds(all: Point[][]): Bounds | null {
  const flat = all.flat();
  if (flat.length === 0) return null;

  let t0 = Infinity;
  let t1 = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of flat) {
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
    if (p.pct < lo) lo = p.pct;
    if (p.pct > hi) hi = p.pct;
  }

  // Widen symmetrically to the floor, then clamp into [0,100] without shrinking the span —
  // a market pinned near 100% must still get its full window, just pushed down.
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > 100) {
    lo -= hi - 100;
    hi = 100;
  }
  return { t0, t1, lo: Math.max(0, lo), hi: Math.min(100, hi) };
}

function project(p: Point, b: Bounds, g: Geometry): [number, number] {
  const span = Math.max(1e-9, b.t1 - b.t0);
  const range = Math.max(1e-9, b.hi - b.lo);
  return [
    g.pad.left + ((p.t - b.t0) / span) * g.plot.w,
    g.pad.top + g.plot.h - ((p.pct - b.lo) / range) * g.plot.h,
  ];
}

/** A polyline, or a flat rule when a series has a single sample and no direction yet. */
function path(points: Point[], b: Bounds, g: Geometry): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [, y] = project(points[0], b, g);
    return `M ${g.pad.left} ${y} L ${g.pad.left + g.plot.w} ${y}`;
  }
  return points
    .map((p, i) => {
      const [x, y] = project(p, b, g);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const RANGE_ORDER = Object.keys(CHART_RANGES) as ChartRange[];

export function PriceChart({ market }: { market: Market }) {
  const [range, setRange] = React.useState<ChartRange>('1D');
  const [cursor, setCursor] = React.useState<number | null>(null);
  // Tracks whether the user picked this range, so widening never fights a deliberate choice.
  const [chosen, setChosen] = React.useState(false);

  const { series, isPending } = useMarketCandles(market.id, market.outcomeCount, range);
  const labels = React.useMemo(() => {
    const byIndex = new Map(market.outcomes.map((o) => [o.index, o.label]));
    return (i: number) => byIndex.get(i) || `Outcome ${i + 1}`;
  }, [market.outcomes]);

  const lines = React.useMemo(() => series.map(toPoints), [series]);
  const b = React.useMemo(() => bounds(lines), [lines]);

  const [frame, width] = useMeasuredWidth(W_FALLBACK);
  const g = React.useMemo(() => geometry(width), [width]);

  /**
   * Widen automatically when the default window is empty.
   *
   * A market that last traded thirty hours ago has a full history and an empty day, and printing
   * "has not traded" over the top of it is simply wrong.
   *
   * Adjusted during render rather than in an effect — same reasoning as `ShieldingProgress`. An
   * effect would commit a paint of the empty state before correcting itself, so every quiet
   * market would flash "has not traded" before the wider window arrived. It converges because
   * each step either finds data, or runs out of ranges, and a pending fetch blocks it meanwhile.
   */
  const widened = chosen ? false : range !== '1D';
  if (!chosen && !isPending && b === null) {
    const next = RANGE_ORDER[RANGE_ORDER.indexOf(range) + 1];
    if (next) setRange(next);
  }

  /** Nearest sample to the cursor, per outcome — the crosshair readout. */
  const readout = React.useMemo(() => {
    if (cursor === null || !b) return null;
    const t = b.t0 + (cursor / g.plot.w) * (b.t1 - b.t0);
    const at = lines.map((pts) => {
      if (pts.length === 0) return null;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      return best;
    });
    const anchor = at.find(Boolean);
    return anchor ? { t: anchor.t, values: at } : null;
  }, [cursor, b, lines, g.plot.w]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * g.w - g.pad.left;
    setCursor(Math.max(0, Math.min(g.plot.w, x)));
  }

  return (
    <section className="plate p-4 sm:p-5">
      <SectionHead
        right={
          <div role="tablist" aria-label="Chart range" className="flex gap-px bg-line">
            {(Object.keys(CHART_RANGES) as ChartRange[]).map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={range === r}
                onClick={() => {
                  setChosen(true);
                  setRange(r);
                }}
                className={cn(
                  // Taller under a thumb, unchanged under a mouse. Horizontal padding is left
                  // alone deliberately: four tabs plus the heading is already the tightest row on
                  // the page, and widening them is what pushes "Price history" into an ellipsis.
                  'mono bg-bg px-2 py-2 text-[10px] tracking-[0.14em] transition-colors sm:py-1',
                  range === r ? 'text-accent-bright' : 'text-ink-mute hover:text-ink',
                )}
              >
                {r}
              </button>
            ))}
          </div>
        }
      >
        Price history
      </SectionHead>

      {/* Legend doubles as the crosshair readout: the value column fills in on hover and holds
          the last price otherwise, so the row never reflows under the pointer. */}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {lines.map((pts, i) => {
          const value = readout?.values[i] ?? pts[pts.length - 1];
          const first = pts[0];
          const delta = value && first ? value.pct - first.pct : null;
          return (
            <li key={i} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-px w-3 shrink-0"
                style={{ background: outcomeVar(i) }}
              />
              <span className="truncate text-[12px] text-ink-dim">{labels(i)}</span>
              <span className="tabular text-[12px]" style={{ color: outcomeVar(i) }}>
                {value ? `${value.pct.toFixed(1)}%` : '—'}
              </span>
              {delta !== null && Math.abs(delta) >= 0.05 && (
                <span
                  className={cn('tabular text-[11px]', delta > 0 ? 'text-pos' : 'text-neg')}
                >
                  {delta > 0 ? '+' : ''}
                  {delta.toFixed(1)}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* The measured element, and the one the SVG fills. Kept outside the empty/plotted branch so
          the width is known before the first series lands rather than a beat after it. */}
      <div ref={frame}>
      {b === null ? (
        <p className="mt-4 flex h-[140px] items-center justify-center border border-line text-center text-[12px] text-ink-mute">
          {isPending ? 'Reading the tape…' : 'No price history yet — this market has not traded.'}
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${g.w} ${g.h}`}
          /*
            `touch-pan-y`, not `touch-none`.

            `touch-action: none` on a full-width band in the middle of a scrolling page is a scroll
            trap: a thumb that starts its swipe anywhere on the chart — which is most of the screen
            on a phone — moves nothing at all, and the page reads as frozen. Vertical panning goes
            back to the browser; horizontal movement still drives the crosshair.
          */
          className="mt-3 w-full touch-pan-y"
          style={{ height: g.h }}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Price history over the last ${range}. ${lines
            .map((pts, i) => {
              const last = pts[pts.length - 1];
              return last ? `${labels(i)} ${last.pct.toFixed(1)} percent` : '';
            })
            .filter(Boolean)
            .join(', ')}`}
          onPointerMove={onMove}
          onPointerLeave={() => setCursor(null)}
        >
          {/* Four hairlines rather than a grid: enough to read a level against, not enough to
              compete with the data. `vector-effect` keeps them 1px under non-uniform scaling. */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = g.pad.top + g.plot.h * f;
            const value = b.hi - (b.hi - b.lo) * f;
            return (
              <g key={f}>
                <line
                  x1={g.pad.left}
                  x2={g.pad.left + g.plot.w}
                  y1={y}
                  y2={y}
                  stroke="var(--line)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={g.w - 4}
                  y={y + 3.5}
                  textAnchor="end"
                  fill="var(--text-mute)"
                  style={{ fontSize: 9, fontFamily: 'var(--font-jetbrains), monospace' }}
                >
                  {value.toFixed(0)}%
                </text>
              </g>
            );
          })}

          {lines.map((pts, i) => (
            <path
              key={i}
              d={path(pts, b, g)}
              fill="none"
              stroke={outcomeVar(i)}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {cursor !== null && readout && (
            <>
              <line
                x1={g.pad.left + cursor}
                x2={g.pad.left + cursor}
                y1={g.pad.top}
                y2={g.pad.top + g.plot.h}
                stroke="var(--line-2)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {readout.values.map((p, i) =>
                p ? (
                  <circle
                    key={i}
                    cx={project(p, b, g)[0]}
                    cy={project(p, b, g)[1]}
                    r={2.5}
                    fill="var(--bg)"
                    stroke={outcomeVar(i)}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </>
          )}

          <text
            x={g.pad.left}
            y={g.h - 4}
            fill="var(--text-mute)"
            style={{ fontSize: 9, fontFamily: 'var(--font-jetbrains), monospace' }}
          >
            {clock(b.t0)}
          </text>
          <text
            x={g.pad.left + g.plot.w}
            y={g.h - 4}
            textAnchor="end"
            fill="var(--text-mute)"
            style={{ fontSize: 9, fontFamily: 'var(--font-jetbrains), monospace' }}
          >
            {readout ? clock(readout.t) : clock(b.t1)}
          </text>
        </svg>
      )}
      </div>

      <p className="mt-2 flex items-center justify-between gap-3">
        <Folio>{widened ? `Quiet lately — showing ${range}` : 'Implied probability'}</Folio>
        <Folio>{CHART_RANGES[range].interval} buckets</Folio>
      </p>
    </section>
  );
}
