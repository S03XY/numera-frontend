'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatUsd } from '@/lib/format';
import { Countdown } from './Countdown';
import type { Market } from '@/lib/api/types';
import { Plate, Seal, Folio } from '@/components/ui/primitives';
import { Distribution, OutcomeRow } from './Outcomes';
import { Sparkline, sparklineChange } from './Sparkline';
import { Bar } from '@/components/ui/Waiting';

const MAX_VISIBLE = 3;

/**
 * Close time, or the settled state that replaced it.
 *
 * The deadline is drawn as a running clock rather than as "in 1d 21h". See {@link Countdown} for
 * why the seconds only tick once they matter, which is the part that keeps a board of sixty cards
 * from re-rendering every second for markets that close next week.
 */
export function MarketStatus({
  market,
  className,
  alwaysTicking,
}: {
  market: Market;
  className?: string;
  /** Draw seconds however far off the close is. For the market page, not the board. */
  alwaysTicking?: boolean;
}) {
  if (market.status === 'RESOLVED') return <Seal className={className}>Settled</Seal>;
  if (market.status === 'INVALID') return <Seal className={className}>Void</Seal>;
  /*
    Not open yet is its own state, and counting down to the close would be the wrong clock.

    A scheduled market is closed to bets and will open later; a finished one is closed forever. The
    engine reverts a trade in the first case with `MarketNotOpenYet`, so showing "Closed" — or worse,
    a live countdown that invites a bet — produces a signed trade that cannot land, failing with a
    condition the trader was never shown.
  */
  if (market.notOpenYet) {
    return (
      <span className={cn('inline-flex items-baseline gap-1.5', className)}>
        <Seal>Opens</Seal>
        <Countdown target={market.startTime} alwaysTicking={alwaysTicking} className="text-ink-mute" />
      </span>
    );
  }
  if (!market.tradingOpen) return <Seal className={className}>Closed</Seal>;

  return (
    <Countdown
      target={market.closeTime}
      alwaysTicking={alwaysTicking}
      className={cn('text-ink-mute', className)}
    />
  );
}

export function MarketCard({
  market,
  index = 0,
  spark,
}: {
  market: Market;
  index?: number;
  /** Last 24h of outcome 0, supplied by the board in one batched read. */
  spark?: string[];
}) {
  const sorted = [...market.outcomes].sort((a, b) => a.index - b.index);
  const visible = sorted.slice(0, MAX_VISIBLE);
  const hidden = sorted.length - visible.length;
  const change = sparklineChange(spark);

  return (
    <Plate as="article" interactive className="group h-full">
      <Link
        href={`/markets/${market.id}`}
        className="flex h-full flex-col p-5 focus:outline-none"
        aria-label={market.title || 'Untitled market'}
      >
        <div className="flex items-center justify-between gap-3">
          <Folio>{String(index + 1).padStart(3, '0')}</Folio>
          <MarketStatus market={market} />
        </div>

        <h3 className="h-card mt-3 line-clamp-2 min-h-11">{market.title || 'Untitled market'}</h3>

        <Distribution outcomes={sorted} className="mt-4" />

        <div className="mt-4 flex-1 space-y-2">
          {visible.map((o) => (
            <OutcomeRow
              key={o.index}
              outcome={o}
              isWinner={market.status === 'RESOLVED' && market.winningOutcomeId === o.index}
            />
          ))}
          {hidden > 0 && <p className="folio pl-[17px]">+{hidden} more</p>}
        </div>

        {/*
          The footer answers "is this worth opening?" — pool size alone never did, because it is
          the same number every time you look. The line and the change are the day's movement on
          the leading outcome, which is what actually distinguishes one card from the next.
        */}
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="tabular text-[11.5px] text-ink-mute">
            {formatUsd(market.pot, market.collateralDecimals, { compact: true })} pool
          </span>
          <span className="flex items-center gap-2">
            {change !== null && Math.abs(change) >= 0.05 && (
              <span
                className={cn('tabular text-[11.5px]', change > 0 ? 'text-pos' : 'text-neg')}
                title={`${sorted[0]?.label || 'Leading outcome'} over the last 24 hours`}
              >
                {change > 0 ? '+' : ''}
                {change.toFixed(1)}
              </span>
            )}
            {spark && spark.length >= 2 ? <Sparkline points={spark} /> : <Folio>Live pricing</Folio>}
          </span>
        </div>
      </Link>
    </Plate>
  );
}

/**
 * The board's loading tile.
 *
 * Drawn as the card's own skeleton rather than as a spinner, so the grid reserves its real
 * geometry and nothing jumps when the markets land. Note there is no `TraceMark` here on purpose:
 * the mark means "work is in flight on your behalf", and a list that has not fetched yet is not
 * that. Sixty marks orbiting at once would also be the first thing the eye tracked on a page whose
 * entire job is showing odds.
 */
export function MarketCardSkeleton() {
  return (
    <div className="plate flex h-full flex-col p-5" role="status" aria-label="Loading market">
      <span className="block text-[10px]">
        <Bar chars={8} />
      </span>
      <span className="mt-4 block text-[14px]">
        <Bar chars={30} />
      </span>
      <span className="mt-1.5 block text-[14px]">
        <Bar chars={18} />
      </span>
      <div className="dist mt-5">
        <div className="dist-seg bg-line-2" style={{ width: '55%' }} />
        <div className="dist-seg bg-line" style={{ width: '45%' }} />
      </div>
      <div className="mt-4 flex-1 space-y-2">
        {[26, 22, 18].map((chars) => (
          <span key={chars} className="block text-[12px]">
            <Bar chars={chars} />
          </span>
        ))}
      </div>
      <span className="mt-5 block text-[10px]">
        <Bar chars={12} />
      </span>
    </div>
  );
}
