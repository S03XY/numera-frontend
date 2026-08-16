'use client';

import { cn } from '@/lib/cn';
import { shouldShowCategoryNav, visibleCategories } from '@/lib/categories';
import type { Category } from '@/lib/api/types';
import { SearchIcon } from '@/components/ui/icons';

export interface MarketFilterState {
  category?: string;
  openOnly: boolean;
  search: string;
}

export function MarketFilters({
  categories,
  value,
  onChange,
}: {
  categories: Category[] | undefined;
  value: MarketFilterState;
  onChange: (next: MarketFilterState) => void;
}) {
  // The switcher is noise while SPORTS is the only category. It appears on its
  // own the moment a second one is enabled in the backend — no frontend change.
  const showCategories = shouldShowCategoryNav(categories);
  const cats = visibleCategories(categories);

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      {/* A full row to itself on a phone. Sharing one with the chips left it at its 200px floor,
          which is a search box you cannot read your own query back from. */}
      <div className="relative w-full sm:w-auto sm:min-w-[200px] sm:flex-1">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-mute" />
        <input
          type="search"
          role="searchbox"
          aria-label="Search markets"
          placeholder="Search markets"
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
          className="field pl-9"
        />
      </div>

      {showCategories && (
        <div className="flex items-center gap-1" role="group" aria-label="Category">
          <FilterChip active={!value.category} onClick={() => onChange({ ...value, category: undefined })}>
            All
          </FilterChip>
          {cats.map((c) => (
            <FilterChip
              key={c.key}
              active={value.category === c.key}
              onClick={() => onChange({ ...value, category: c.key })}
            >
              {c.label}
            </FilterChip>
          ))}
        </div>
      )}

      <FilterChip
        active={value.openOnly}
        onClick={() => onChange({ ...value, openOnly: !value.openOnly })}
      >
        Open only
      </FilterChip>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'mono h-11 border px-3.5 text-[10.5px] uppercase tracking-[0.16em] transition-colors sm:h-10',
        active
          ? 'border-accent-dim bg-accent-wash text-accent-bright'
          : 'border-line text-ink-mute hover:border-line-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
