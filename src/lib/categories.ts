import type { Category } from './api/types';

/**
 * Category presentation.
 *
 * The platform launches with SPORTS only, but categories are **backend-driven**:
 * the UI renders whatever `GET /api/categories` returns. Adding "Politics" later
 * is a backend/admin action with ZERO frontend changes — the nav appears
 * automatically once a second category exists.
 *
 * Only the optional cosmetics (icon/accent) are known to the client, and every
 * unknown key falls back to a neutral default, so an unrecognized category never
 * breaks the page.
 */
export interface CategoryDisplay {
  icon: string;
  blurb: string;
}

const DISPLAY: Record<string, CategoryDisplay> = {
  SPORTS: { icon: '⚽', blurb: 'Match results, tournaments, and live sport outcomes.' },
  POLITICS: { icon: '🗳️', blurb: 'Elections, policy, and geopolitical events.' },
  CRYPTO: { icon: '₿', blurb: 'Prices, protocol milestones, and on-chain events.' },
  ENTERTAINMENT: { icon: '🎬', blurb: 'Awards, releases, and culture.' },
};

const FALLBACK: CategoryDisplay = { icon: '◈', blurb: 'Prediction markets.' };

export function categoryDisplay(key: string | null | undefined): CategoryDisplay {
  if (!key) return FALLBACK;
  return DISPLAY[key.toUpperCase()] ?? FALLBACK;
}

/** Enabled categories only, stably ordered for a non-jumping nav. */
export function visibleCategories(categories: Category[] | undefined): Category[] {
  if (!categories) return [];
  return categories.filter((c) => c.enabled).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The category switcher is noise when there is only one category (today: SPORTS).
 * It appears on its own the moment a second one is enabled in the backend.
 */
export function shouldShowCategoryNav(categories: Category[] | undefined): boolean {
  return visibleCategories(categories).length > 1;
}
