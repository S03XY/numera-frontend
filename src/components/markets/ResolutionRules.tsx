'use client';

import { cn } from '@/lib/cn';
import type { Market } from '@/lib/api/types';

/**
 * The published rule for how this market settles.
 *
 * ## Why this is on the page at all
 *
 * Anyone can propose the result here, and anyone can stake money challenging a proposal. That only
 * works if everybody is reading from the same rule book — otherwise a dispute is two people who
 * were each right about a different question, and one of them loses a stake for it.
 *
 * ## Why it is a commitment and not just copy
 *
 * The rule is inside the market's `metadataHash`, which the engine stores at creation and has no
 * function to change. So it cannot be reworded once people have bet: a different rule produces a
 * different hash, and no longer matches the market it claims to describe. Anyone can re-encode what
 * the API serves, hash it, and check.
 *
 * That is worth saying out loud on the page, which is what the footnote does. "We promise not to
 * move the goalposts" is worth very little; "the goalposts are in a hash you can check" is worth
 * something, and it is the difference this product is selling.
 *
 * ## Why `<details>` rather than a modal or a tooltip
 *
 * It is long-form text somebody needs to read carefully, sometimes while deciding whether to stake
 * money on it. Native disclosure keeps it findable, printable, linkable and keyboard-navigable, and
 * open by default in the one place it matters most — see `defaultOpen`.
 */
export function ResolutionRules({
  market,
  defaultOpen = false,
  className,
}: {
  market: Market;
  /** Open on load. Used where somebody is about to act on the rule rather than merely browse. */
  defaultOpen?: boolean;
  className?: string;
}) {
  // Markets created before rules existed have none, and inventing one would be worse than showing
  // nothing — the whole value here is that the text is the committed text.
  if (!market.resolutionRules) return null;

  return (
    <details
      open={defaultOpen}
      className={cn('group mt-3 max-w-[62ch] border-t border-line pt-3', className)}
    >
      <summary className="folio cursor-pointer list-none text-ink-dim transition-colors hover:text-ink marker:content-['']">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="text-[10px] transition-transform group-open:rotate-90">
            ▸
          </span>
          How this market settles
        </span>
      </summary>

      <p className="mt-2.5 whitespace-pre-line text-[13px] leading-relaxed text-ink-dim">
        {market.resolutionRules}
      </p>

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-mute">
        Written when the market was created and fixed in its on-chain record, so it cannot be
        changed now that there is money on it.
      </p>
    </details>
  );
}
