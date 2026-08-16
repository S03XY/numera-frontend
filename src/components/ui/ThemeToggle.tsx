'use client';

import * as React from 'react';
import { useTheme } from '@/lib/theme';
import { MoonIcon, SunIcon } from './icons';

/**
 * Light/dark switch.
 *
 * Renders a stable placeholder until mounted: the server cannot know which
 * theme the inline script chose, so drawing an icon before hydration would
 * guarantee a mismatch on half of all loads.
 */
const noopSubscribe = () => () => {};

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  // false while server-rendering, true once hydrated — with no effect and no
  // second render pass to get there.
  const mounted = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  return (
    <button
      type="button"
      onClick={toggle}
      className={`flex size-9 items-center justify-center border border-line text-ink-dim transition-colors hover:border-accent-dim hover:text-accent-bright ${className ?? ''}`}
      aria-label={mounted ? `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme` : 'Switch theme'}
    >
      {mounted ? (
        theme === 'dark' ? (
          <SunIcon className="size-4" />
        ) : (
          <MoonIcon className="size-4" />
        )
      ) : (
        <span className="size-4" />
      )}
    </button>
  );
}
