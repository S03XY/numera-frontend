import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarketList } from './MarketList';
import { renderWithProviders, makeMarket } from '@/test/render';
import { endpoints } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/errors';

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    markets: { list: vi.fn(), categories: vi.fn() },
  },
}));

const list = endpoints.markets.list as unknown as ReturnType<typeof vi.fn>;
const categories = endpoints.markets.categories as unknown as ReturnType<typeof vi.fn>;

const SPORTS_ONLY = [{ key: 'SPORTS', label: 'Sports', enabled: true }];
const TWO_CATEGORIES = [...SPORTS_ONLY, { key: 'CRYPTO', label: 'Crypto', enabled: true }];

function page(items = [makeMarket()], total = items.length) {
  return { items, total, limit: 24, offset: 0 };
}

beforeEach(() => {
  list.mockReset().mockResolvedValue(page());
  categories.mockReset().mockResolvedValue(SPORTS_ONLY);
});

describe('MarketList', () => {
  it('never flashes a placeholder when the API answers at once (REGRESSION)', async () => {
    // The loading treatment is withheld for a beat. A local API answers in tens
    // of milliseconds, and one frame of scrambling glyphs reads as a glitch
    // rather than a load — so a fast response must show no placeholder at all.
    renderWithProviders(<MarketList />);
    expect(screen.queryByLabelText('Loading markets')).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'Argentina vs France' })).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 markets')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading markets')).not.toBeInTheDocument();
  });

  it('shows the decrypting placeholder when the API is slow (positive)', async () => {
    list.mockReset().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(page()), 600)),
    );
    renderWithProviders(<MarketList />);

    expect(
      await screen.findByLabelText('Loading markets', {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Argentina vs France' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading markets')).not.toBeInTheDocument();
  });

  it('reports how much of the result set is shown', async () => {
    list.mockResolvedValue(page([makeMarket()], 12));
    renderWithProviders(<MarketList />);
    expect(await screen.findByText('Showing 1 of 12 markets')).toBeInTheDocument();
  });

  it('hides the category switcher while only one category is enabled', async () => {
    renderWithProviders(<MarketList />);
    await screen.findByRole('heading', { name: 'Argentina vs France' });
    expect(screen.queryByRole('group', { name: 'Category' })).not.toBeInTheDocument();
  });

  it('reveals the category switcher as soon as a second one is enabled (growth path)', async () => {
    categories.mockResolvedValue(TWO_CATEGORIES);
    renderWithProviders(<MarketList />);
    expect(await screen.findByRole('group', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crypto' })).toBeInTheDocument();
  });

  it('debounces search into a single query, not one per keystroke', async () => {
    renderWithProviders(<MarketList />);
    await screen.findByRole('heading', { name: 'Argentina vs France' });

    const before = list.mock.calls.length;
    await userEvent.type(screen.getByRole('searchbox'), 'arsenal');
    // Seven keystrokes have landed and none has queried yet.
    expect(list.mock.calls.length).toBe(before);

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'arsenal' }),
        expect.anything(),
      ),
    );
    // One request for the whole word, not seven.
    expect(list.mock.calls.length).toBe(before + 1);
  });

  it('passes the open-only filter through', async () => {
    renderWithProviders(<MarketList />);
    await screen.findByRole('heading', { name: 'Argentina vs France' });

    await userEvent.click(screen.getByRole('button', { name: 'Open only' }));
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ openOnly: true }),
      expect.anything(),
    );
  });

  it('distinguishes an empty result from a filtered-out one (negative)', async () => {
    list.mockResolvedValue(page([], 0));
    renderWithProviders(<MarketList />);
    expect(await screen.findByText('No markets yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open only' }));
    expect(await screen.findByText('Nothing matches those filters')).toBeInTheDocument();
  });

  it('offers a retry on a transient failure (negative)', async () => {
    list.mockRejectedValue(new ApiError(500, 'InternalServerError', 'boom'));
    renderWithProviders(<MarketList />);

    expect(await screen.findByText('Couldn’t load markets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
