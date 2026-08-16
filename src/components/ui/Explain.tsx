'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { SectionHead } from './primitives';
import { InfoIcon } from './icons';

/**
 * A section heading that can explain itself, on request.
 *
 * ## Why almost every explanation on this site belongs behind a button
 *
 * A privacy product has a lot to say for itself. Positions are held by accounts we cannot link to
 * a login; a bet routes through a fresh account; the key you sign in with is never attached to a
 * trade. Each of those sentences earns its place the first time somebody reads it — and then
 * never again, while continuing to occupy the panel forever.
 *
 * The test applied throughout: **does this change what the reader does next?** A shortfall, a
 * disabled control, a warning before a transfer that will fail — those change the next action and
 * stay on the surface. Everything that merely explains *why the product works the way it does*
 * goes in here, one press away, where it is still available to anyone who wants it and invisible
 * to everyone who does not.
 *
 * A drop-in for {@link SectionHead}: same heading, same right slot, plus `detail`.
 */
export interface ExplainProps {
  /** The heading itself. */
  children: React.ReactNode;
  /** What the ⓘ discloses. Paragraphs, a `Datum`, a `role="note"` — whatever fits. */
  detail: React.ReactNode;
  /** Anything else in the heading's right slot; the ⓘ sits after it. */
  right?: React.ReactNode;
  /** Announced on the toggle. Say what it explains, not "more info". */
  label: string;
  className?: string;
  level?: 2 | 3;
}

export function Explain({ children, detail, right, label, className, level }: ExplainProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <SectionHead
        className={className}
        level={level}
        right={
          <span className="flex items-center gap-2.5">
            {right}
            <button
              type="button"
              aria-expanded={open}
              aria-label={label}
              onClick={() => setOpen((was) => !was)}
              className={cn(
                // A real target rather than a bare 14px glyph, which is well under any sane
                // minimum and — sitting at the end of the rule, a few pixels from the plate's
                // border — gave the icon nothing of its own to occupy. The box centres it, which
                // buys clearance on the right as well. The negative margin keeps the heading its
                // old height at both sizes; a thumb gets 32px, a mouse keeps the tighter 24.
                'grid size-8 -my-2 place-items-center transition-colors sm:size-6 sm:-my-1',
                open ? 'text-accent-bright' : 'text-ink-mute hover:text-ink',
              )}
            >
              <InfoIcon />
            </button>
          </span>
        }
      >
        {children}
      </SectionHead>

      {open && (
        <div className="mt-3 space-y-2.5 border border-line px-3 py-3 text-[11.5px] leading-relaxed text-ink-dim">
          {detail}
        </div>
      )}
    </>
  );
}
