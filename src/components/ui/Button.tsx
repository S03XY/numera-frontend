import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * `pos` and `neg` are the directional primaries — green and red. They are for the
 * rare button whose *colour carries meaning* (buy vs sell), not for emphasis; a
 * green "Save" would spend the signal that makes buy legible at a glance.
 */
type Variant = 'primary' | 'ghost' | 'quiet' | 'pos' | 'neg';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  quiet: 'btn-quiet',
  pos: 'btn-pos',
  neg: 'btn-neg',
};

/**
 * Taller on a phone, tighter on a laptop.
 *
 * The desktop sizes are drawn for a mouse — a 28px `sm` is a precise little terminal control and
 * looks right beside a hairline. Under a thumb it is a miss, and the buttons wearing these sizes
 * are Collect winnings, Confirm and Settle: the ones where a mis-tap costs something. So every
 * step gets a touch-sized floor first and the instrument proportions return at `sm`, which is
 * also where the pointer stops being a finger.
 */
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-[10px] sm:h-7 sm:px-2.5',
  md: 'h-11 px-4 sm:h-9',
  lg: 'h-12 px-6 sm:h-11',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * Mono, uppercase, tracked, square. Buttons read as terminal commands rather
 * than app chrome — which is what keeps the interface feeling like an
 * instrument instead of a website.
 */
export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={cn('btn', VARIANTS[variant], SIZES[size], className)} {...props} />
  );
}
