import { describe, expect, it } from 'vitest';
import { categoryDisplay, shouldShowCategoryNav, visibleCategories } from './categories';
import type { Category } from './api/types';

const cat = (key: string, label: string, enabled = true): Category => ({ key, label, enabled });

describe('categoryDisplay', () => {
  it('returns known display metadata (positive)', () => {
    expect(categoryDisplay('SPORTS').icon).toBe('⚽');
    expect(categoryDisplay('sports').icon).toBe('⚽'); // case-insensitive
  });

  it('falls back for unknown or missing keys (negative — future categories must not break)', () => {
    expect(categoryDisplay('ESPORTS').icon).toBe('◈');
    expect(categoryDisplay(null).icon).toBe('◈');
    expect(categoryDisplay(undefined).blurb).toBeTruthy();
  });
});

describe('visibleCategories', () => {
  it('filters disabled and sorts by label', () => {
    const result = visibleCategories([
      cat('POLITICS', 'Politics'),
      cat('CRYPTO', 'Crypto', false),
      cat('SPORTS', 'Sports'),
    ]);
    expect(result.map((c) => c.key)).toEqual(['POLITICS', 'SPORTS']);
  });

  it('handles undefined/empty input (negative)', () => {
    expect(visibleCategories(undefined)).toEqual([]);
    expect(visibleCategories([])).toEqual([]);
  });
});

describe('shouldShowCategoryNav', () => {
  it('hides the nav at launch when only SPORTS exists', () => {
    expect(shouldShowCategoryNav([cat('SPORTS', 'Sports')])).toBe(false);
  });

  it('reveals the nav automatically once a second category is enabled (the growth path)', () => {
    expect(shouldShowCategoryNav([cat('SPORTS', 'Sports'), cat('POLITICS', 'Politics')])).toBe(true);
  });

  it('ignores disabled categories when deciding (regression)', () => {
    expect(
      shouldShowCategoryNav([cat('SPORTS', 'Sports'), cat('POLITICS', 'Politics', false)]),
    ).toBe(false);
  });

  it('hides for empty/undefined', () => {
    expect(shouldShowCategoryNav([])).toBe(false);
    expect(shouldShowCategoryNav(undefined)).toBe(false);
  });
});
