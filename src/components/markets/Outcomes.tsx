'use client';

import { cn } from '@/lib/cn';
import { formatPercent, wadToPercent } from '@/lib/format';
import { tickClass, usePriceTick } from '@/lib/usePriceTick';
import type { Outcome } from '@/lib/api/types';

/**
 * Outcome colour.
 *
 * One hue, five intensities — index 0 carries the house crimson and the rest
 * step down the graphite scale. A prediction market reflexively reaches for
 * green-vs-red here; Numera does not, because a second hue would break the
 * single-light-source rule the whole brand is built on.
 */
export function outcomeVar(index: number): string {
  return `var(--o-${Math.min(index, 4)})`;
}

/** The full probability distribution as one stacked hairline bar. */
export function Distribution({
  outcomes,
  className,
  height = 3,
}: {
  outcomes: Outcome[];
  className?: string;
  height?: number;
}) {
  const segments = [...outcomes]
    .sort((a, b) => a.index - b.index)
    .map((o) => ({ index: o.index, label: o.label, pct: wadToPercent(o.priceWad, 2) ?? 0 }));

  const total = segments.reduce((a, s) => a + s.pct, 0);
  if (total <= 0) return <div className={cn('dist', className)} style={{ height }} aria-hidden="true" />;

  return (
    <div
      className={cn('dist', className)}
      style={{ height }}
      role="img"
      aria-label={segments
        .map((s) => `${s.label || `Outcome ${s.index + 1}`} ${formatPercent(String(Math.round(s.pct * 1e16)))}`)
        .join(', ')}
    >
      {segments.map((s) => (
        <span
          key={s.index}
          className="dist-seg"
          style={{ width: `${(s.pct / total) * 100}%`, background: outcomeVar(s.index) }}
        />
      ))}
    </div>
  );
}

/** A labelled outcome line: marker, name, probability. */
export function OutcomeRow({
  outcome,
  isWinner,
  className,
}: {
  outcome: Outcome;
  isWinner?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="size-[7px] shrink-0"
          style={{ background: outcomeVar(outcome.index) }}
        />
        <span className={cn('truncate text-[13.5px]', isWinner ? 'text-ink' : 'text-ink-dim')}>
          {outcome.label || `Outcome ${outcome.index + 1}`}
        </span>
        {isWinner && <span className="folio !text-accent-bright">Won</span>}
      </span>
      <Ticking
        value={outcome.priceWad}
        className="tabular shrink-0 text-[13.5px]"
        style={{ color: outcomeVar(outcome.index) }}
      >
        {formatPercent(outcome.priceWad)}
      </Ticking>
    </div>
  );
}

/**
 * A number that acknowledges its own movement.
 *
 * The wash is drawn behind the digits with a little negative inset, so the highlight reads as a
 * mark on the page rather than a control that appeared and vanished — nothing shifts, because the
 * padding is compensated by the same margin.
 */
export function Ticking({
  value,
  children,
  className,
  style,
}: {
  value: string | bigint | null | undefined;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const tick = usePriceTick(value);
  return (
    <span className={cn('-mx-1 px-1', className, tickClass(tick))} style={style}>
      {children}
    </span>
  );
}

/** The single-outcome pressure bar used on the detail page. */
export function OddsBar({ outcome }: { outcome: Outcome }) {
  const pct = wadToPercent(outcome.priceWad, 1) ?? 0;
  return (
    <div className="odds" role="img" aria-label={`${outcome.label} ${pct.toFixed(1)} percent`}>
      <div className="odds-fill" style={{ width: `${pct}%` }} />
      <div className="mono absolute inset-0 flex items-center justify-between px-3 text-[10.5px] tracking-[0.16em]">
        <span className="truncate text-ink">{(outcome.label || `Outcome ${outcome.index + 1}`).toUpperCase()}</span>
        <Ticking value={outcome.priceWad} className="tabular text-ink">
          {pct.toFixed(1)}%
        </Ticking>
      </div>
    </div>
  );
}
