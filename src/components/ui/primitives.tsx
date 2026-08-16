import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The house's structural vocabulary: hairlines, plates, seals and kickers.
 * Nothing here has a border-radius — Numera is drawn with rules, not corners.
 */

/** Uppercase mono label, 0.26em tracked. The section marker of the house. */
export function Kicker({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('kicker', className)}>{children}</span>;
}

/** Smaller, quieter kicker — page furniture: counts, dates, indices. */
export function Folio({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('folio', className)}>{children}</span>;
}

/** A boxed mono tag. Turns crimson when its parent plate is hovered. */
export function Seal({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('seal', className)}>{children}</span>;
}

export function Rule({ className }: { className?: string }) {
  return <div className={cn('rule', className)} aria-hidden="true" />;
}

/**
 * A kicker with a rule running out to the full width.
 *
 * Renders a real heading, not a styled span: these are the landmarks a screen
 * reader user navigates the page by, and the kicker treatment is presentation
 * only. Level defaults to h2 — every screen puts these under its h1.
 */
export function SectionHead({
  children,
  right,
  className,
  level = 2,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    /*
      The heading is the part that gives way.

      Every item here used to be `shrink-0` except the rule, so once the rule had collapsed to
      nothing the row simply kept growing past its container — and what stuck out was the last
      thing in it, the ⓘ, hanging over the plate's border. `.kicker` sets 0.26em of letter
      spacing, so these strings are far wider than they look and a narrow column reaches that
      point sooner than you would expect.

      Now the heading truncates instead. It is the one element here that degrades gracefully: the
      right slot carries a status and a control, both of which have to stay whole and legible.
    */
    /*
      ...and when even that is not enough, the right slot drops to its own line.

      Truncating alone was the desktop answer and it does not survive a phone. `TOP UP THIS
      MARKET` is 170px of tracked small caps and `Ready to trade` plus the ⓘ is another 157; in a
      256px column the heading gave way to `TOP UP T…` and the panel stopped saying what it was.
      Losing the name of the panel you are about to put money into is worse than losing the line.

      `flex-wrap` decides this on measurements rather than a breakpoint, which is what it has to
      be: the right slot carries a status whose width changes with the state — `Locked`, `Needs
      funds`, `Awaiting proposal` — so no fixed screen width is the right place to switch. The rule
      has a zero flex-basis, so it contributes nothing to that decision and simply fills whatever
      is left. `ml-auto` keeps the slot right-aligned on whichever line it lands on.
    */
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      <Heading className="kicker min-w-0 truncate font-normal">{children}</Heading>
      <Rule className="min-w-0 flex-1" />
      {right ? <div className="ml-auto shrink-0">{right}</div> : null}
    </div>
  );
}

export function Plate({
  children,
  className,
  interactive = false,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
  as?: 'div' | 'article' | 'section' | 'li';
}) {
  return (
    <Tag className={cn('plate', interactive && 'plate-interactive', className)}>{children}</Tag>
  );
}

/** Live indicator. Pulses when connected, sits inert when not. */
export function StatusDot({ live, className }: { live: boolean; className?: string }) {
  return <span className={cn('status-dot', !live && 'status-dot-idle', className)} aria-hidden="true" />;
}

/** Label/value row — the readout pattern used in every detail panel. */
export function Datum({
  label,
  value,
  tone,
  strong,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: 'pos' | 'neg' | 'accent' | 'warn';
  strong?: boolean;
}) {
  return (
    /*
      Both halves may shrink, and the value may break mid-token.

      Neither could before, and a 42-character address is the case that proved it: `justify-between`
      with two rigid children simply grows past its container, so the shielded address on the Wallet
      screen and the operator's wallet in the console both ran out through the plate's right-hand
      border — clipped rather than visibly broken, because the body hides horizontal overflow. A
      mono hash has no spaces to wrap at, hence `break-words` rather than normal wrapping.
    */
    <div className="flex items-baseline justify-between gap-3 sm:gap-4">
      <dt className="min-w-0 text-[12px] text-ink-mute">{label}</dt>
      <dd
        className={cn(
          'tabular min-w-0 break-words text-right text-[13px]',
          strong ? 'font-medium text-ink' : 'text-ink-dim',
          tone === 'pos' && 'text-pos',
          tone === 'neg' && 'text-neg',
          tone === 'accent' && 'text-accent-bright',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
