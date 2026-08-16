import { cn } from '@/lib/cn';
import { wadToPercent } from '@/lib/format';

/**
 * A market's last day, at card size.
 *
 * The board used to render every market identically inert — same bar, same rows, same pool
 * figure — so nothing on it answered "which of these is worth opening?". Movement is the answer,
 * and it needs about forty pixels to show.
 *
 * Drawn against its own min/max rather than 0–100. At this size an absolute scale flattens every
 * market into the same horizontal line; the shape is the information here, and the figure beside
 * it carries the magnitude.
 */

const W = 64;
const H = 18;

export interface SparklineProps {
  /** Bucketed closes, WAD, oldest first. */
  points: string[] | undefined;
  className?: string;
}

/** Change across the window, in percentage points, or `null` if there is nothing to compare. */
export function sparklineChange(points: string[] | undefined): number | null {
  if (!points || points.length < 2) return null;
  const first = wadToPercent(points[0], 2);
  const last = wadToPercent(points[points.length - 1], 2);
  if (first === null || last === null) return null;
  return last - first;
}

export function Sparkline({ points, className }: SparklineProps) {
  const values = (points ?? []).map((p) => wadToPercent(p, 2)).filter((v): v is number => v !== null);

  // Two points is the minimum that can have a direction. One is a dot, and a dot on a card reads
  // as a rendering fault rather than as "this has traded once".
  if (values.length < 2) {
    return <span className={cn('inline-block', className)} style={{ width: W, height: H }} />;
  }

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const up = values[values.length - 1] >= values[0];

  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      // Inset by a stroke width top and bottom so the extremes are not clipped in half.
      const y = 1 + (H - 2) - ((v - lo) / span) * (H - 2);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={d}
        fill="none"
        stroke={up ? 'var(--pos)' : 'var(--neg)'}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
