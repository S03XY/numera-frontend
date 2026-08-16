'use client';

import * as React from 'react';
import { ApiError } from '@/lib/api/errors';
import { useCategories, useMarkets, useSparklines } from '@/lib/hooks/useMarkets';
import { EmptyState, ErrorState } from '@/components/ui/Feedback';
import { MarketCard, MarketCardSkeleton } from './MarketCard';
import { useDelayedFlag } from '@/components/ui/Waiting';
import { MarketFilters, type MarketFilterState } from './MarketFilters';

/** Debounce so typing in search does not fire a request per keystroke. */
function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function MarketList() {
  const [filters, setFilters] = React.useState<MarketFilterState>({ openOnly: false, search: '' });
  const debouncedSearch = useDebounced(filters.search);

  const { data: categories } = useCategories();
  const { data, isPending, isError, error, refetch } = useMarkets({
    category: filters.category,
    openOnly: filters.openOnly || undefined,
    search: debouncedSearch || undefined,
    sort: 'closeTime',
    order: 'asc',
    limit: 24,
  });

  // Withheld for a beat: a local API answers in tens of milliseconds, and a
  // single frame of placeholder tiles reads as a glitch rather than a load.
  const showLoading = useDelayedFlag(isPending);
  const hasFilters = Boolean(filters.category || filters.search || filters.openOnly);

  // One request for the visible page, issued here rather than inside the card — a card that
  // fetched its own history would put the board's request count on the number of markets.
  const ids = React.useMemo(() => (data?.items ?? []).map((m) => m.id), [data]);
  const { data: sparks } = useSparklines(ids);

  return (
    <div className="space-y-6">
      <MarketFilters categories={categories} value={filters} onChange={setFilters} />

      {showLoading && (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-busy="true"
          aria-label="Loading markets"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <MarketCardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn’t load markets"
          description={error instanceof ApiError ? error.userMessage : 'Please try again in a moment.'}
          onRetry={() => void refetch()}
        />
      )}

      {!isPending && !isError && data && data.items.length === 0 && (
        <EmptyState
          title={hasFilters ? 'Nothing matches those filters' : 'No markets yet'}
          description={
            hasFilters
              ? 'Try clearing the search, or include markets that have already closed.'
              : 'The first books are being written. Check back shortly.'
          }
        />
      )}

      {!isPending && !isError && data && data.items.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Cards land immediately. They used to fade and lift in on scroll, staggered across
                the grid, which on a board of live prices meant the first thing the eye tracked was
                the animation rather than the odds. */}
            {data.items.map((market, i) => (
              <MarketCard key={market.id} market={market} index={i} spark={sparks?.get(market.id)} />
            ))}
          </div>
          <p className="folio">
            Showing {data.items.length} of {data.total} markets
          </p>
        </>
      )}
    </div>
  );
}
