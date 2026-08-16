'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { SealGlyph } from './icons';

/**
 * Waiting, in the language of the product.
 *
 * ## One mark, not a paragraph
 *
 * What used to live here was scrambling ciphertext: ninety hex characters over three lines while a
 * bet was proved and relayed. The idea was right, and a product whose whole premise is that the
 * trader is hidden should look like one while it works. The dose was wrong. At that length nobody
 * reads ciphertext as ciphertext, they read a paragraph of nonsense, and the eye keeps trying to
 * parse it. Six glyphs would have read as a hash; ninety read as a wall.
 *
 * So the same claim is made by a single mark: a hairline running the perimeter of a small square.
 * Nothing to read, nothing to parse, and it survives being drawn at 20px in a market tile, which
 * the ciphertext never did.
 *
 * ## The loop is one gesture, in two halves
 *
 * {@link TraceMark} draws the loop while the work is in flight, and {@link SettledMark} closes it
 * when the bet lands. The wait deliberately stops at {@link SETTLED_AT}, three quarters of the way
 * round, so the landing has a real quarter left to shut. Nothing is replaced when a bet completes:
 * the thing already on screen **finishes**.
 *
 * ## No timer
 *
 * The old treatment drove every instance from a module-level ticker through `useSyncExternalStore`,
 * because a board of sixty market tiles would otherwise have been sixty `setInterval`s and sixty
 * re-render roots. This needs none of that: it is CSS, so sixty of them cost sixty compositor
 * animations and zero React renders. The progress arc is the only thing React touches, and only
 * when progress actually changes.
 */

/**
 * How far round the loop a completed wait leaves the arc.
 *
 * The handoff to {@link SettledMark} is seamless only if both agree on this: the landing animation
 * starts at exactly this offset. Move one and you must move the other, or the mark visibly jumps
 * backwards at the moment of success, which is the one moment it must not.
 */
export const SETTLED_AT = 0.75;

/** The loop's perimeter in SVG user units: 2 × (32 + 32). */
const PERIMETER = 128;

export interface TraceMarkProps {
  /**
   * 0 to 1, or omitted for work whose stages cannot be observed.
   *
   * Callers driving a real operation should scale into {@link SETTLED_AT} rather than to 1, so the
   * landing has something left to close.
   */
  progress?: number;
  /** The one human sentence. Announced to assistive tech, never drawn. */
  label: string;
  /** Sizing utility, e.g. `size-6`. Defaults to 36px, which is where the lock stays legible. */
  className?: string;
}

/**
 * The wait: a hairline running the perimeter of a square.
 *
 * Two strokes over one shape, and they answer different questions. The arc only ever grows, so it
 * says how far along the work is. The comet circles regardless, so it says the work is still
 * happening — which matters because a private bet can sit in one stage for a minute, and a bar
 * that has not moved in that long reads as a hang however honest it is.
 *
 * Hidden from assistive tech as a drawing. The role and label on the wrapper carry the meaning.
 */
export function TraceMark({ progress, label, className }: TraceMarkProps) {
  const known = progress !== undefined;
  const clamped = Math.max(0, Math.min(1, progress ?? 0));

  return (
    <span
      className={cn('relative inline-flex shrink-0', className ?? 'size-9')}
      role={known ? 'progressbar' : 'status'}
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(clamped * 100) : undefined}
    >
      <svg viewBox="0 0 40 40" className="size-full" aria-hidden="true">
        <rect x="4" y="4" width="32" height="32" className="trace-track" />
        {known && (
          <rect
            x="4"
            y="4"
            width="32"
            height="32"
            className="trace-arc"
            style={{ strokeDashoffset: PERIMETER * (1 - clamped) }}
          />
        )}
        <rect x="4" y="4" width="32" height="32" className="trace-comet" />
      </svg>

      {/*
        The lock the loop is drawn around, with a gloss crossing it on the diagonal.

        Two copies of one glyph: a dim base and a lit copy revealed through a travelling mask. The
        lock never moves, only the light over it does — a lock that slides about is a lock coming
        loose, which is precisely the wrong thing for this to say.
      */}
      <span className="trace-lock" aria-hidden="true">
        <LockGlyph />
        <span className="trace-lock-lit">
          <LockGlyph />
        </span>
      </span>
    </span>
  );
}

/**
 * The padlock, sized as a fraction of the mark rather than in pixels.
 *
 * Percentage sizing is what lets one component sit inside the 36px panel mark and a 24px inline
 * one without a caller ever passing a size for the lock itself.
 */
function LockGlyph() {
  return <SealGlyph className="size-[46%]" />;
}

/**
 * The landing: the same loop, closing.
 *
 * The last quarter snaps shut, the join sparks and dies, and the lock inside it lights. Pair it
 * with `.circuit-panel` on the surrounding panel plus a `.circuit-pulse` ring or two for the
 * border pulse, and `.settle-in` on whatever arrives behind it.
 *
 * Purely decorative: the panel around it says what happened, in words, to everyone.
 */
export function SettledMark({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className ?? 'size-9')} aria-hidden="true">
      <svg viewBox="0 0 40 40" className="size-full">
        <rect x="4" y="4" width="32" height="32" className="trace-track" />
        <rect x="4" y="4" width="32" height="32" className="circuit-arc" />
        <rect x="4" y="4" width="32" height="32" className="circuit-spark" />
      </svg>
      {/* The same lock, going from dim to lit as the loop shuts around it. */}
      <span className="circuit-lock">
        <LockGlyph />
      </span>
    </span>
  );
}

/**
 * The panel-level wait: the mark, centred, and nothing else.
 *
 * Deliberately wordless on screen. What used to sit in this box was a headline, a running clock, a
 * four-step list and two closing paragraphs, and every one of them was written to answer "is this
 * stuck?". Five answers to one question reads as a system apologising for itself. The mark answers
 * it by moving.
 */
export function Waiting({
  progress,
  label,
  className,
}: {
  progress?: number;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-center py-3', className)}>
      <TraceMark progress={progress} label={label} />
    </div>
  );
}

/**
 * A figure that has not arrived yet, drawn at the width it will occupy.
 *
 * Sized in `ch` and `em` rather than pixels, so one component covers a 34px balance and an 11px
 * table cell without either caller passing a size. `aria-hidden`, because every caller already
 * labels the region it sits in; announcing "loading" twice is worse than not at all.
 */
export function Bar({ chars = 7, className }: { chars?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('skeleton inline-block h-[0.62em] align-middle', className)}
      style={{ width: `${chars}ch` }}
    />
  );
}

/**
 * A block of content that has not arrived: the drop-in for a paragraph or a panel body.
 *
 * Ragged widths on purpose. Uniform bars read as a template, varied ones read as real content
 * still resolving.
 */
export function BarStack({
  lines = [30, 24, 18],
  label = 'Loading',
  className,
}: {
  /** Line widths in characters, top to bottom. */
  lines?: readonly number[];
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2.5', className)} role="status" aria-label={label}>
      {lines.map((chars, i) => (
        <span key={i} className="block text-[13px]">
          <Bar chars={chars} />
        </span>
      ))}
    </div>
  );
}

/** Label-and-value rows: the queues and holdings tables, while they load. */
export function RowStack({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3 py-1" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 text-[13px]">
          <Bar chars={24} />
          <Bar chars={7} />
        </div>
      ))}
    </div>
  );
}

/**
 * True only once `active` has held for `delayMs`.
 *
 * A local API answers in tens of milliseconds. Rendering a loading state for a single frame and
 * tearing it down again is worse than showing nothing: it reads as a flicker. So the treatment is
 * withheld until the wait is long enough to be worth explaining, then shown for real.
 *
 * Deliberately asymmetric — it turns off immediately. Once the data is here, holding a placeholder
 * open to satisfy a minimum duration is just a slower app.
 */
export function useDelayedFlag(active: boolean, delayMs = 180): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  const [wasActive, setWasActive] = React.useState(active);

  // Reset during render rather than in an effect: clearing it afterwards would commit one frame
  // still showing the placeholder over freshly-arrived data.
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setElapsed(false);
  }

  React.useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);

  return active && elapsed;
}
