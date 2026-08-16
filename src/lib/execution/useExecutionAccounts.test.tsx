import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';

const list = vi.fn();
vi.mock('@/lib/api/endpoints', () => ({ endpoints: { markets: { list } } }));

const unlinkMock = { executionRoot: null as unknown };
vi.mock('@/lib/pool/PoolProvider', () => ({ usePool: () => unlinkMock }));

// Derivation itself is exercised against the real curve in `keys.test.ts`. Here it only has to be
// injective, so the assertions can say which market ids were derived over.
vi.mock('./keys', () => ({
  marketAccountAddress: (_root: unknown, marketRef: string) => `0x${marketRef}`,
}));

const { useExecutionAccounts } = await import('./useExecutionAccounts');

function Probe() {
  const accounts = useExecutionAccounts();
  return <output data-testid="accounts">{accounts.join(',')}</output>;
}

function renderProbe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

/** A page of the catalogue, shaped like the API's envelope. */
function page(ids: string[], total: number) {
  return { items: ids.map((id) => ({ id })), total, limit: 100, offset: 0 };
}

const accounts = () => screen.getByTestId('accounts').textContent;

beforeEach(() => {
  list.mockReset();
  unlinkMock.executionRoot = { seed: 'root' };
});

describe('useExecutionAccounts', () => {
  it('never asks for more than the server will page (REGRESSION)', async () => {
    // This asked for 200. `PaginationDto` caps `limit` at 100 and answers a bigger one with a
    // **400**, not a clamp — so the request failed on every render, the id list stayed empty, the
    // positions query never ran, and every screen reported that the user held nothing. The market
    // balance still read fine off the chain, which made it look like a broken indexer rather than
    // a request that was rejected before it was answered.
    list.mockResolvedValue(page(['a', 'b'], 2));
    renderProbe();

    await waitFor(() => expect(accounts()).toBe('0xa,0xb'));
    for (const call of list.mock.calls) {
      expect(call[0].limit).toBeLessThanOrEqual(100);
    }
  });

  it('pages until it has the whole catalogue (positive)', async () => {
    // A short list does not look broken. It looks like a user with no positions in the markets
    // that fell off the end — which is the same silent failure, one page further out.
    const first = Array.from({ length: 100 }, (_, i) => `m${i}`);
    list
      .mockResolvedValueOnce(page(first, 102))
      .mockResolvedValueOnce({ items: [{ id: 'm100' }, { id: 'm101' }], total: 102, limit: 100, offset: 100 });
    renderProbe();

    await waitFor(() => expect(accounts()).toContain('0xm101'));
    expect(list.mock.calls[1][0].offset).toBe(100);
  });

  it('stops at the last page rather than asking for one more (efficiency)', async () => {
    list.mockResolvedValue(page(['a'], 1));
    renderProbe();

    await waitFor(() => expect(accounts()).toBe('0xa'));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('derives nothing while the session is locked (negative)', async () => {
    // No root, no addresses — and no catalogue request either, since there would be nothing to do
    // with the answer.
    unlinkMock.executionRoot = null;
    renderProbe();

    await waitFor(() => expect(accounts()).toBe(''));
    expect(list).not.toHaveBeenCalled();
  });

  it('derives over the same ids regardless of the order they arrive in (positive)', async () => {
    // The list is sorted before derivation so the address set — and therefore the positions query
    // key — is stable across refetches that happen to reorder.
    list.mockResolvedValue(page(['c', 'a', 'b'], 3));
    renderProbe();

    await waitFor(() => expect(accounts()).toBe('0xa,0xb,0xc'));
  });
});
