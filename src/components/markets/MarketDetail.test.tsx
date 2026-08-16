import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarketDetail } from './MarketDetail';
import { TradeTape } from './TradeTape';
import { renderWithProviders, makeMarket } from '@/test/render';
import { endpoints } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/errors';
import type { Trade } from '@/lib/api/types';

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    markets: { byId: vi.fn() },
    trades: { byMarket: vi.fn() },
    resolution: { forMarket: vi.fn(async () => null) },
    // The chart asks per outcome. Omitting this made every render throw inside a query, which
    // react-query swallowed as an error state — the page still passed while the chart was dead.
    prices: { candles: vi.fn(async () => []) },
    positions: { forAccounts: vi.fn(async () => []) },
  },
}));

vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => ({ status: 'anonymous' }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const channelMock = { connected: true, liveTrades: [] as unknown[] };
vi.mock('@/lib/realtime/useMarketChannel', () => ({
  useMarketChannel: () => channelMock,
}));

const byId = endpoints.markets.byId as unknown as ReturnType<typeof vi.fn>;
const byMarket = endpoints.trades.byMarket as unknown as ReturnType<typeof vi.fn>;

const MARKET_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678';

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 't1',
  marketRef: MARKET_ID,
  engine: 'LS_LMSR',
  side: 'BUY',
  account: ACCOUNT,
  outcomeIndex: 0,
  shares: '100000000',
  amount: '60000000',
  spreadWad: '5000000000000000',
  priceWad: '600000000000000000',
  txHash: '0xtx1',
  blockNumber: '1',
  timestamp: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  channelMock.connected = true;
  channelMock.liveTrades = [];
  byId.mockReset().mockResolvedValue(makeMarket({ id: MARKET_ID }));
  byMarket.mockReset().mockResolvedValue({ items: [trade()], total: 1, limit: 30, offset: 0 });
});

describe('MarketDetail', () => {
  it('renders the market, its prices and its details (positive)', async () => {
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);

    expect(
      await screen.findByRole('heading', { name: 'Argentina vs France', level: 1 }),
    ).toBeInTheDocument();
    // The percentage appears in the odds bars, the ticket and the tape.
    expect(screen.getAllByText('60.0%').length).toBeGreaterThanOrEqual(1);
    // No algorithm name on a betting slip — see the Details panel. What it costs is the spread.
    expect(screen.queryByText('Damped LS-LMSR')).not.toBeInTheDocument();
    expect(screen.getByText(/widening toward close/i)).toBeInTheDocument();
  });

  it('draws an odds bar per outcome', async () => {
    const { container } = renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    await screen.findByRole('heading', { name: 'Argentina vs France', level: 1 });
    expect(container.querySelectorAll('.odds')).toHaveLength(2);
  });

  it('offers a way back to the market list', async () => {
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    expect(await screen.findByRole('link', { name: /markets/i })).toHaveAttribute('href', '/');
  });

  it('carries a price history chart, not just the current odds (positive)', async () => {
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    expect(
      await screen.findByRole('heading', { name: /price history/i, level: 2 }),
    ).toBeInTheDocument();
  });

  it('drops the tape below the ticket on a phone (MOBILE REGRESSION)', async () => {
    // The layout collapses to one column below `lg`. Document order is now column order — the two
    // columns flow independently so neither can strand the other with a row-height gap — so the
    // tape sits between the chart and the ticket in the markup and `order-last` moves it past
    // both when the columns collapse. Without it a phone user scrolls through every fill in the
    // market to reach the thing they came to do.
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    await screen.findByRole('heading', { name: 'Argentina vs France', level: 1 });

    const tape = screen.getByRole('heading', { name: /trade activity/i, level: 2 });
    expect(tape.closest('section')).toHaveClass('order-last');
    // ...and back into column order once there is room for two columns.
    expect(tape.closest('section')).toHaveClass('lg:order-none');
  });

  it('gives each column its own flow, so neither strands the other (REGRESSION)', async () => {
    // This was a 2×2 grid pinned by row and column, and row one was sized by the trade column —
    // funding, ticket, position — which is far taller than prices plus a chart. The tape, pinned
    // to row two, began level with the bottom of the ticket and left several hundred pixels of
    // nothing under the price history.
    const { container } = renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    await screen.findByRole('heading', { name: 'Argentina vs France', level: 1 });

    const prices = screen.getByRole('heading', { name: /market prices/i, level: 2 });
    const column = prices.closest('section')?.parentElement;
    expect(column).toHaveClass('lg:flex', 'lg:flex-col');

    // No row pinning in the page layout: that is the mechanism that produced the gap.
    //
    // Scoped past the tape, which pins rows for an unrelated reason — each fill is its own
    // two-line grid on a phone, sized by its own content, so it cannot strand anything. The
    // guard is about panels pinned into a shared grid whose rows are as tall as their tallest
    // member; a per-row grid inside a table is not that.
    const pinned = Array.from(container.querySelectorAll('[class*="row-start"]')).filter(
      (el) => el.closest('table') === null,
    );
    expect(pinned).toEqual([]);
  });

  it('puts funding before trading, and numbers it (positive)', async () => {
    // Collateral cannot reach the contracts except through this market's execution account, so
    // funding is not one panel among several — it is a precondition. Numbering says so without a
    // paragraph, and tells a first-time trader that a Buy button they cannot press yet is a
    // sequence rather than a fault.
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    await screen.findByRole('heading', { name: 'Argentina vs France', level: 1 });

    const funding = screen.getByRole('heading', { name: /top up this market/i, level: 2 });
    const ticket = screen.getByRole('heading', { name: /step 2 · trade/i, level: 2 });
    expect(funding.compareDocumentPosition(ticket) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the feed as live when the channel is connected', async () => {
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('says it is reconnecting when the socket drops (negative)', async () => {
    channelMock.connected = false;
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);
    expect(await screen.findByText('Reconnecting')).toBeInTheDocument();
  });

  it('renders a not-found state with no retry (negative)', async () => {
    byId.mockRejectedValue(new ApiError(404, 'NotFound', 'market not found'));
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);

    expect(await screen.findByText('Market not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('offers a retry for transient failures (negative)', async () => {
    byId.mockRejectedValue(new ApiError(500, 'InternalServerError', 'boom'));
    renderWithProviders(<MarketDetail marketId={MARKET_ID} />);

    expect(await screen.findByText(/couldn’t load this market/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('TradeTape', () => {
  const market = makeMarket({ id: MARKET_ID });

  it('renders fills with shielded accounts, never a user identity (PRIVACY)', () => {
    renderWithProviders(<TradeTape market={market} trades={[trade()]} liveTrades={[]} />);

    expect(screen.getByText('0x1234…5678')).toBeInTheDocument();
    expect(screen.getByText(/cannot be traced to a person/i)).toBeInTheDocument();
    expect(screen.getByText('Argentina')).toBeInTheDocument();
    expect(screen.getByText('$60')).toBeInTheDocument();
  });

  it('exposes the tape as a real table with column headers', () => {
    renderWithProviders(<TradeTape market={market} trades={[trade()]} liveTrades={[]} />);
    expect(screen.getByRole('columnheader', { name: 'Price' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
  });

  it('restacks each fill into two lines on a phone instead of scrolling sideways (MOBILE)', () => {
    // Six columns of a fill need about 560px and a phone has 280, so this used to be a horizontal
    // scroller — the one block on the market page nobody could read without dragging it, and the
    // block that proves the product's claim. Below `sm` a fill becomes a small grid: when / what /
    // how much on top, side / price / who underneath. From `sm` up the table returns intact.
    const { container } = renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} />,
    );

    const row = container.querySelector('tbody tr');
    expect(row).toHaveClass('grid', 'sm:table-row');
    // The scroller is the fallback for a real table, not the mobile layout.
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
    expect(container.querySelector('.sm\\:overflow-x-auto')).not.toBeNull();
  });

  it('windows the tape and offers a way to older fills (positive)', () => {
    // Unbounded, this list grew with the market: on an active one it pushed Details and Resolution
    // below several screens of history nobody had asked to read. Ten at rest, the rest a scroll
    // away — and `overscroll-contain` so reaching the end does not hand the flick to the page.
    const { container } = renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} hasMore onLoadMore={vi.fn()} />,
    );

    const scroller = container.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass('overscroll-contain');
    expect(screen.getByRole('button', { name: /load older fills/i })).toBeInTheDocument();
  });

  it('keeps a control beside the scroll trigger (a11y)', async () => {
    // Infinite scroll with no button is a list some people cannot reach the end of: a keyboard
    // user who tabs rather than scrolls, or a browser without IntersectionObserver. This one holds
    // the evidence that the market is real, so it must not be scroll-only.
    const onLoadMore = vi.fn();
    renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} hasMore onLoadMore={onLoadMore} />,
    );

    // The suite stubs IntersectionObserver to report an immediate intersection, so the sentinel
    // has already fired once — which is the right behaviour when the sentinel starts on screen
    // (too few fills to fill the box, so keep loading until it is full). Assert the click reaches
    // the handler rather than pinning a total that belongs to the stub.
    const before = onLoadMore.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /load older fills/i }));
    expect(onLoadMore.mock.calls.length).toBe(before + 1);
  });

  it('does not auto-load a second page before anyone scrolls (REGRESSION)', () => {
    // One page is only a little taller than the box, so whether the sentinel starts inside the
    // observer's reach comes down to the exact height of ten rows — which is not settled at first
    // paint, because the webfonts are still loading and fallback metrics are shorter. Measured in
    // a real browser: every market page fetched two pages on open and showed twenty of "the latest
    // ten". Requiring a scroll makes page one page one whatever the fonts do.
    //
    // The suite's IntersectionObserver stub reports an immediate intersection, so without the gate
    // this fires on mount — which is precisely the browser behaviour being pinned.
    const onLoadMore = vi.fn();
    renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} hasMore onLoadMore={onLoadMore} />,
    );

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('arms the auto-loader once the tape has been scrolled (positive)', () => {
    const onLoadMore = vi.fn();
    const { container } = renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} hasMore onLoadMore={onLoadMore} />,
    );

    const scroller = container.querySelector('.overflow-y-auto')!;
    fireEvent.scroll(scroller);

    expect(onLoadMore).toHaveBeenCalled();
  });

  it('offers nothing more to load once the tape is exhausted (negative)', () => {
    renderWithProviders(<TradeTape market={market} trades={[trade()]} liveTrades={[]} />);
    expect(screen.queryByRole('button', { name: /load older fills/i })).not.toBeInTheDocument();
  });

  it('shows every fetched fill rather than capping the list (REGRESSION)', () => {
    // The tape used to slice to 40. With paging that silently discards the page the reader just
    // asked for — they scroll, a request goes out, and nothing appears.
    const many = Array.from({ length: 45 }, (_, i) => trade({ txHash: `0x${i}` }));
    const { container } = renderWithProviders(
      <TradeTape market={market} trades={many} liveTrades={[]} />,
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(45);
  });

  it('states its table roles so restacking cannot strip them (a11y REGRESSION)', () => {
    // Changing `display` on a table element is exactly what drops its implicit ARIA semantics in
    // a browser. Without these written out, the phone layout would read to a screen reader as a
    // stack of anonymous boxes rather than a table of trades.
    const { container } = renderWithProviders(
      <TradeTape market={market} trades={[trade()]} liveTrades={[]} />,
    );

    expect(container.querySelector('table')).toHaveAttribute('role', 'table');
    expect(container.querySelector('tbody tr')).toHaveAttribute('role', 'row');
    expect(container.querySelectorAll('tbody td[role="cell"]')).toHaveLength(6);
  });

  it('shows an empty state when nothing has traded (negative)', () => {
    renderWithProviders(<TradeTape market={market} trades={[]} liveTrades={[]} />);
    expect(screen.getByText('No trades yet.')).toBeInTheDocument();
  });

  it('prefers the pushed row over a duplicate fetched one (regression — no double rows)', () => {
    renderWithProviders(
      <TradeTape
        market={market}
        trades={[trade({ txHash: '0xdup' })]}
        liveTrades={[
          {
            side: 'BUY',
            account: ACCOUNT,
            outcomeIndex: 0,
            amount: '60000000',
            priceWad: '600000000000000000',
            txHash: '0xdup',
            timestamp: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(screen.getAllByText('0x1234…5678')).toHaveLength(1);
  });

  it('flashes a pushed fill in its direction', () => {
    const { container } = renderWithProviders(
      <TradeTape
        market={market}
        trades={[]}
        liveTrades={[
          {
            side: 'SELL',
            account: ACCOUNT,
            outcomeIndex: 0,
            amount: '10000000',
            priceWad: '600000000000000000',
            txHash: '0xlive',
            timestamp: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(container.querySelector('.flash-down')).toBeInTheDocument();
  });

  it('labels every fill as YES or NO, coloured by direction (REGRESSION)', () => {
    // A `SHORT` is `buyComplement` — money going in, betting the outcome loses. Rendering the raw
    // side printed "SHORT" in green, which asks a trader to know that a green SHORT is a purchase.
    // The label is the side of the bet; the colour is whether money went in or came out.
    const { rerender } = renderWithProviders(
      <TradeTape market={market} trades={[trade({ side: 'SHORT', txHash: '0xn' })]} liveTrades={[]} />,
    );
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.queryByText('SHORT')).not.toBeInTheDocument();
    expect(screen.getByText('NO')).toHaveClass('text-pos');

    rerender(
      <TradeTape market={market} trades={[trade({ side: 'SELL', txHash: '0xs' })]} liveTrades={[]} />,
    );
    expect(screen.getByText('YES')).toHaveClass('text-neg');
  });

  it('links every fill to the explorer (positive)', () => {
    // The product's claim is that anyone can verify the trade and nobody can tell who made it.
    // Without a link the first half is only an assertion.
    renderWithProviders(
      <TradeTape market={market} trades={[trade({ side: 'BUY', txHash: '0xabc' })]} liveTrades={[]} />,
    );
    const link = screen.getByRole('link', { name: /monad explorer/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/tx/0xabc'));
    expect(link).toHaveAttribute('target', '_blank');
    // `noreferrer` matters: without it the explorer tab can reach back into this one.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});
