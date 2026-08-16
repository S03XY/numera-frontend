import { cn } from '@/lib/cn';
import { SealGlyph } from './icons';

/**
 * A pseudonymous execution account.
 *
 * This is the product's central claim rendered as a component. The address is
 * shown as an *assertion of anonymity*, never as missing data — no "unknown",
 * no placeholder avatar, no greyed-out user slot. Screen readers get the full
 * address plus the guarantee, because the sighted design states it visually
 * through the seal glyph alone.
 */
export function ShieldedAccount({
  address,
  showGlyph = true,
  className,
}: {
  address: string;
  showGlyph?: boolean;
  className?: string;
}) {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}
      title="Shielded execution account — cannot be traced to a person"
    >
      {showGlyph && <SealGlyph className="size-2.5 shrink-0 text-accent-bright" />}
      <span className="mono text-[11.5px] text-ink-dim">{short}</span>
      <span className="sr-only">
        Shielded execution account {address}. This account cannot be traced to a person.
      </span>
    </span>
  );
}

/** The standing privacy mark, used in headers and hero furniture. */
export function PrivacyMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 border border-line px-2.5 py-1 text-accent-bright',
        className,
      )}
    >
      <SealGlyph className="size-2.5" />
      <span className="folio !text-accent-bright">Shielded</span>
    </span>
  );
}
