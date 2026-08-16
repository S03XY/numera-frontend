import type * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  /** For a width that has to match the content it stands in for — see `LoadingLine`. */
  style?: React.CSSProperties;
}) {
  return <div className={cn('skeleton', className)} style={style} aria-hidden="true" />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="border border-line px-6 py-16 text-center">
      <p className="h-card">{title}</p>
      {description && (
        <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-ink-dim">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-line px-6 py-14 text-center" role="alert">
      <p className="h-card text-accent-bright">{title}</p>
      {description && (
        <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-ink-dim">
          {description}
        </p>
      )}
      {onRetry && (
        <div className="mt-5 flex justify-center">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}
