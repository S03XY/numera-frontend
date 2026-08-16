'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Transient notices, in the house style.
 *
 * Errors used to land as small red paragraphs wherever the failing control
 * happened to be — easy to miss on a long page, and gone the moment the
 * component re-rendered. Money flows fail for reasons the user must actually
 * read (no gas, wrong network, a reverted trade), so they surface here instead:
 * one place, above everything, dismissible, and persistent until dismissed when
 * the news is bad.
 *
 * Deliberately hand-rolled rather than a toast library. The requirement is a
 * fixed stack of bordered plates that inherit the theme's own tokens — the
 * zero-radius, hairline-border look the rest of the app uses — which is less
 * code than restyling someone else's component out of its rounded defaults.
 */

export type ToastTone = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  /** Optional second line: the detail, the tx hash, the thing to try next. */
  detail?: string;
}

interface ToastContextValue {
  show: (toast: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  /** Convenience wrappers — the common cases, so call sites stay one line. */
  error: (title: string, detail?: string) => number;
  success: (title: string, detail?: string) => number;
  info: (title: string, detail?: string) => number;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/**
 * Errors never auto-dismiss.
 *
 * A failed deposit is not an incidental notification — it is the answer to
 * "what happened to my money", and it must still be on screen when the user
 * looks back at the tab.
 */
const DISMISS_AFTER: Record<ToastTone, number | null> = {
  error: null,
  success: 6_000,
  info: 5_000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((current) => {
        // Identical message already up? Replace rather than stack — a retry loop
        // should not bury the screen in copies of the same sentence.
        const deduped = current.filter(
          (t) => !(t.title === toast.title && t.detail === toast.detail),
        );
        return [...deduped, { ...toast, id }].slice(-4);
      });

      const after = DISMISS_AFTER[toast.tone];
      if (after !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), after),
        );
      }
      return id;
    },
    [dismiss],
  );

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      error: (title, detail) => show({ tone: 'error', title, detail }),
      success: (title, detail) => show({ tone: 'success', title, detail }),
      info: (title, detail) => show({ tone: 'info', title, detail }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

const TONE_STYLES: Record<ToastTone, { bar: string; title: string }> = {
  error: { bar: 'bg-neg', title: 'text-neg' },
  success: { bar: 'bg-pos', title: 'text-pos' },
  info: { bar: 'bg-accent-bright', title: 'text-accent-bright' },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      // `polite`, not `assertive`: these interrupt nothing, and a screen reader
      // should finish the sentence it is on before announcing one.
      aria-live="polite"
      // The extra bottom padding is the iOS home indicator. Without it a failed-deposit toast —
      // which never auto-dismisses — sits with its last line under the system gesture bar, and
      // the dismiss button is in the strip that swipes the app away instead of tapping.
      style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((toast) => {
        const tone = TONE_STYLES[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-[420px] gap-3 border border-line-2 bg-bg-2 p-3.5 shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)]"
          >
            <span aria-hidden="true" className={cn('w-0.5 shrink-0', tone.bar)} />
            <div className="min-w-0 flex-1">
              <p className={cn('text-[13px] leading-snug', tone.title)}>{toast.title}</p>
              {toast.detail && (
                <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-dim">
                  {toast.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss"
              className="-mt-0.5 shrink-0 px-1 text-[14px] leading-none text-ink-mute transition-colors hover:text-ink"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
