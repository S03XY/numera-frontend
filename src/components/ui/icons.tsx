/** Brand and interface glyphs, drawn as crisp inline SVG. No emoji, no icon font. */

type IconProps = { className?: string };

/**
 * The Numera mark: a sealed box with conviction filling it from the left.
 * It is the odds bar reduced to a glyph — the product in 24 pixels.
 */
export function NumeraMark({ className = 'size-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="4.5" width="11.8" height="15" fill="var(--accent)" opacity="0.9" />
    </svg>
  );
}

/** A closed padlock body — used wherever a trader identity is deliberately absent. */
export function SealGlyph({ className = 'size-3' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M7 10V7.5a5 5 0 0 1 10 0V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="square"
      />
      <rect x="4" y="10" width="16" height="10.5" fill="currentColor" />
    </svg>
  );
}

export function SunIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.4M12 19.6V22M22 12h-2.4M4.4 12H2M19.07 4.93l-1.7 1.7M6.63 17.37l-1.7 1.7M19.07 19.07l-1.7-1.7M6.63 6.63l-1.7-1.7" strokeLinecap="square" />
    </svg>
  );
}

export function MoonIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.8 8.8 0 1 0 10.9 10.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SearchIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" strokeLinecap="square" />
    </svg>
  );
}

export function ArrowIcon({ className = 'size-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 12h15M13 6l6 6-6 6" strokeLinecap="square" />
    </svg>
  );
}

export function CheckIcon({ className = 'size-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m4 12.5 5 5L20 6.5" strokeLinecap="square" />
    </svg>
  );
}

/**
 * Square rather than round, because nothing in this house has a border-radius.
 * The rule under the bar is what makes it read as an "i" at 14px.
 */
/**
 * The disclosure affordance on every section heading.
 *
 * Square, like everything else here. It reads as a control rather than as a piece of the frame
 * because of the space around it — see the target box in {@link Explain} — not because of its
 * shape; a lone circle in a rectilinear set solved that at the cost of belonging.
 */
export function InfoIcon({ className = 'size-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="3.5" width="17" height="17" />
      <path d="M12 10.5v7M12 6.75v1.5" strokeLinecap="square" />
    </svg>
  );
}

/**
 * An external link, for anything that leaves the app for a block explorer.
 *
 * Deliberately small and low-contrast at the call site: it is a way to verify a claim we have
 * already made, not a call to action.
 */
export function ExternalLinkIcon({ className = 'size-3' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.5 3.5H3.5v9h9v-3M9.5 3.5h3v3M12.5 3.5L7 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Two overlapping sheets — the copy affordance.
 *
 * Square corners like everything else in the house, and drawn at the same 1.4 stroke as the
 * external-link glyph beside it so a row of small controls reads as one weight.
 */
export function CopyIcon({ className = 'size-3' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.5 5.5V2.5h8v8h-3M2.5 5.5h8v8h-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
