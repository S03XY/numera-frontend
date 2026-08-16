'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { CheckIcon, CopyIcon } from './icons';

/**
 * Copy a value, and say that it worked.
 *
 * ## Why this is shared rather than written per call site
 *
 * Every address in this product is a 42-character hash that someone eventually has to paste
 * somewhere — into a faucet, into a block explorer, into a message asking us what went wrong. On a
 * phone, selecting one by hand is the difference between a two-second job and giving up.
 *
 * The parts that are easy to get wrong and tedious to get right twice: `navigator.clipboard` is
 * permission-gated and throws outright in some browsers, the confirmation has to be visible
 * without moving the layout, and a screen reader has to be told what was copied rather than
 * hearing "button".
 *
 * The failure path is deliberately silent. The value is always on screen next to this — copying is
 * a convenience, and an error toast about a clipboard is noise about something the user can still
 * do by hand.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** What is being copied, for the accessible name — "market account address", not "copy". */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  // Cleared on unmount so a component that disappears mid-confirmation cannot set state after it.
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Blocked or unavailable. The value is visible either way.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied' : 'Copy'}
      className={cn(
        // A real target under a thumb, and the same box in both states so the row never shifts as
        // the glyph swaps.
        'grid size-7 shrink-0 place-items-center transition-colors sm:size-6',
        copied ? 'text-pos' : 'text-ink-mute hover:text-ink',
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon />}
      {/*
        Announced rather than left to the icon swap, which a screen reader has no way to notice.

        `aria-live` alone, deliberately not `role="status"`: the role would put a live region into
        the accessibility tree of every panel that shows an address, and those panels have status
        regions of their own for things that matter more than a clipboard — a syncing balance, a
        settling transfer. Two of them on a page makes "the status" ambiguous to a screen reader
        and to anything querying by role. `aria-live` gives the announcement and claims no role.
      */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied to clipboard` : ''}
      </span>
    </button>
  );
}
