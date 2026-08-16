'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { formatPercent, formatUsd } from '@/lib/format';
import type { Market, Trade } from '@/lib/api/types';
import type { TradePayload } from '@/lib/realtime/socket';
import { ShieldedAccount } from '@/components/ui/Shielded';
import { outcomeVar } from './Outcomes';
import { ExternalLinkIcon } from '@/components/ui/icons';
import { monadTestnet } from '@/lib/chain/evm';

/** One source for the explorer, shared with the chain config the app already trusts. */
const EXPLORER = monadTestnet.blockExplorers?.default.url ?? '';

interface Row {
  key: string;
  side: string;
  txHash: string;
  account: string;
  outcomeIndex: number;
  amount: string;
  priceWad: string;
  timestamp: string;
  live: boolean;
}

function time(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * The tape.
 *
 * Every fill is public — size, price, direction, timestamp — and every actor is
 * a fresh shielded account. Reading it top to bottom shows you the market in
 * full and tells you nothing about who is in it.
 */
export function TradeTape({
  market,
  trades,
  liveTrades = [],
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  market: Market;
  trades: Trade[] | undefined;
  liveTrades?: TradePayload[];
  /** More fills exist beyond what has been fetched. */
  hasMore?: boolean;
  loadingMore?: boolean;
  /**
   * Fetch the next page.
   *
   * Optional so the tape still renders from a plain array — on a screen with no pagination, and in
   * the tests, where a scroll container that demands a fetcher would be the tail wagging the dog.
   */
  onLoadMore?: () => void;
}) {
  const rows = React.useMemo<Row[]>(() => {
    const seen = new Set<string>();
    const out: Row[] = [];

    for (const t of liveTrades) {
      const key = `${t.txHash}-${t.outcomeIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...t, key, live: true });
    }
    for (const t of trades ?? []) {
      const key = `${t.txHash}-${t.outcomeIndex}`;
      // A pushed row already carries this fill; showing both would double it. Also what makes
      // offset paging safe here: a later page re-serving rows that have shifted down is absorbed.
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...t, key, live: false });
    }
    // No cap. The window is the container's height and the list is bounded by what has actually
    // been fetched — slicing here would silently discard a page the reader just asked for.
    return out;
  }, [trades, liveTrades]);

  /**
   * Whether the reader has moved the tape at all.
   *
   * The auto-loader stays off until they do, and that gate is doing real work rather than being
   * cautious: one page is only a little taller than the box, so whether the sentinel starts inside
   * the observer's reach comes down to the exact height of ten rows — which is not settled at first
   * paint, because the house webfonts are still loading and the fallback metrics are shorter. The
   * result was a market page that quietly fetched two pages every time it opened, and showed twenty
   * of "the latest ten".
   *
   * Tuning the margin against that is a race. Requiring a scroll is not: page one is page one until
   * the reader asks for more, whatever the fonts do. The button below is unaffected, so nobody who
   * cannot scroll is stuck.
   */
  const [scrolled, setScrolled] = React.useState(false);

  const sentinel = useLoadMoreSentinel({
    enabled: scrolled && hasMore && !loadingMore,
    onLoadMore,
  });

  if (rows.length === 0) {
    return <p className="py-10 text-center text-[13px] text-ink-mute">No trades yet.</p>;
  }

  return (
    /*
      Six columns of a fill need about 560px. A phone has 280.

      The tape used to answer that with a horizontal scroller, which on the market page means the
      one block of content nobody can read without dragging it sideways — and it is the block that
      proves the product's claim, so it is the last one that should be awkward to check.

      Below `sm` each fill becomes two lines in a small grid: when / what / how much on top, which
      side / at what price / by whom underneath. From `sm` up the display properties revert and it
      is the same table it always was.

      ARIA roles are stated explicitly because changing `display` on a table element is exactly
      what strips its implicit semantics in a real browser — the grid would otherwise read to a
      screen reader as a stack of anonymous boxes rather than a table of trades.
    */
    /*
      A window onto the tape, not the whole of it.

      Ten fills is what the panel shows at rest; the rest is a scroll away. Unbounded, this list
      grew with the market — on an active one it pushed the whole right-hand column, Details and
      Resolution included, below several screens of history nobody had asked to read.

      `overscroll-contain` so reaching the bottom of the tape does not hand the momentum to the
      page behind it. On a phone that scroll-chaining is what makes a nested list feel broken:
      you flick to read older fills and the entire market page leaves instead.
    */
    <div
      className="max-h-[26rem] overflow-y-auto overscroll-contain sm:overflow-x-auto"
      // The list grows under the reader as pages load, so it is announced as such rather than
      // silently mutating for anyone not watching it.
      aria-busy={loadingMore}
      // Arms the auto-loader. Latched rather than tracked: this fires on every scroll frame and
      // setting the same `true` repeatedly would re-render the whole tape as the reader moves.
      onScroll={scrolled ? undefined : () => setScrolled(true)}
    >
      <table role="table" className="w-full border-collapse sm:min-w-[560px]">
        {/*
          Sticky, because a header that scrolls away takes the meaning of five columns of bare
          numbers with it. Opaque rather than translucent — rows passing underneath a see-through
          header is worse than no header. Hidden below `sm` where the layout is restacked and each
          row labels itself by position.
        */}
        <thead
          role="rowgroup"
          // `surface-plate`, not `bg-bg`: it has to be opaque to hide the rows scrolling under it,
          // and the plate is a wash *over* the page background — so the page background alone is
          // visibly darker than its surroundings. Unprefixed because the row is `hidden` below
          // `sm`, where there is no header to paint.
          className="surface-plate hidden sm:sticky sm:top-0 sm:z-10 sm:table-header-group"
        >
          <tr role="row" className="border-b border-line">
            {['Time', 'Side', 'Outcome', 'Size', 'Price', 'Account'].map((h, i) => (
              <th
                key={h}
                role="columnheader"
                scope="col"
                className={cn(
                  'folio pb-2 font-normal',
                  i === 0 ? 'text-left' : 'text-right',
                  // Outcome is the one left-aligned column in the middle of right-aligned ones, so
                  // it needs the same gutter its cells have — without it "SIDE" ends exactly where
                  // "OUTCOME" begins and the header reads "SIDEOUTCOME".
                  i === 2 && 'text-left sm:pl-4',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="block sm:table-row-group">
          {rows.map((r) => {
            const outcome = market.outcomes.find((o) => o.index === r.outcomeIndex);
            // Direction decides the colour, the outcome side decides the label.
            //
            // `SHORT` is `buyComplement` — money going in, betting the outcome loses — so it is a
            // NO in green, not a "SHORT". Traders here pick yes or no; nobody should have to learn
            // that a green "SHORT" is a purchase.
            const isSell = r.side === 'SELL';
            const sideLabel = r.side === 'SHORT' ? 'NO' : 'YES';
            return (
              <tr
                key={r.key}
                role="row"
                className={cn(
                  'grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-line/60 py-2 transition-colors sm:table-row sm:gap-0 sm:py-0',
                  r.live && (isSell ? 'flash-down' : 'flash-up'),
                )}
              >
                <td
                  role="cell"
                  className="tabular mono col-start-1 row-start-1 py-0 text-left text-[11.5px] text-ink-mute sm:table-cell sm:py-2.5"
                >
                  <span className="flex items-center gap-1.5">
                    {/*
                      Every row here is a real transaction, and the whole claim of the product is
                      that you can check it without being able to tell who made it. The link is the
                      cheapest way to let someone verify that for themselves.
                    */}
                    <a
                      href={`${EXPLORER}/tx/${r.txHash}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="View this trade on Monad Explorer"
                      aria-label="View this trade on Monad Explorer"
                      className="shrink-0 text-ink-mute transition-colors hover:text-ink"
                    >
                      <ExternalLinkIcon />
                    </a>
                    {time(r.timestamp)}
                  </span>
                </td>
                <td
                  role="cell"
                  className={cn(
                    'mono col-start-1 row-start-2 py-0 text-left text-[10.5px] tracking-[0.14em] sm:table-cell sm:py-2.5 sm:text-right',
                    isSell ? 'text-neg' : 'text-pos',
                  )}
                >
                  {sideLabel}
                </td>
                <td
                  role="cell"
                  className="col-start-2 row-start-1 min-w-0 py-0 pl-0 text-left sm:table-cell sm:py-2.5 sm:pl-4"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-[6px] shrink-0"
                      style={{ background: outcomeVar(r.outcomeIndex) }}
                    />
                    <span className="truncate text-[12.5px] text-ink-dim">
                      {outcome?.label || `Outcome ${r.outcomeIndex + 1}`}
                    </span>
                  </span>
                </td>
                <td
                  role="cell"
                  className="tabular col-start-3 row-start-1 py-0 text-right text-[12.5px] text-ink sm:table-cell sm:py-2.5"
                >
                  {formatUsd(r.amount, market.collateralDecimals)}
                </td>
                <td
                  role="cell"
                  className="tabular col-start-3 row-start-2 py-0 text-right text-[12.5px] text-ink-dim sm:table-cell sm:py-2.5"
                >
                  {formatPercent(r.priceWad)}
                </td>
                <td
                  role="cell"
                  className="col-start-2 row-start-2 min-w-0 py-0 text-left sm:table-cell sm:py-2.5 sm:text-right"
                >
                  <ShieldedAccount address={r.account} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/*
        The trigger, and a control that does the same job.

        The sentinel loads the next page when it scrolls into view; the button is what happens when
        that cannot fire — a keyboard user tabbing rather than scrolling, a browser with no
        IntersectionObserver, or a page short enough that the sentinel is already on screen and
        never "enters" it. Infinite scroll with no button is a list some people simply cannot reach
        the end of, and this one holds the evidence that the market is real.
      */}
      {hasMore && (
        <div ref={sentinel} className="px-3 py-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="folio transition-colors hover:text-ink disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Load older fills'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Fires `onLoadMore` when the element it is attached to scrolls into view.
 *
 * Observed against the **scroll container**, not the viewport: the tape scrolls inside a fixed
 * height, so a sentinel at the bottom of that box is nowhere near the bottom of the window and a
 * default `root` would either never fire or fire immediately depending on where the panel happened
 * to sit. Passing the element's own scrollable ancestor is what makes it mean "you have reached the
 * end of the tape".
 *
 * `rootMargin` starts the fetch slightly before the end is actually visible, so the next page is
 * usually there by the time the reader arrives. Deliberately small: a ten-row page is only a little
 * taller than the box, so a generous margin puts the sentinel inside the observer's reach at rest
 * and fetches page two before anyone has scrolled — which turns "show me the latest ten" into two
 * requests and twenty rows on every market that loads.
 */
const PREFETCH_MARGIN_PX = 64;
function useLoadMoreSentinel({
  enabled,
  onLoadMore,
}: {
  enabled: boolean;
  onLoadMore?: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Held in a ref so a new callback identity on every render does not tear down and rebuild the
  // observer — which, with `rootMargin`, would re-fire the moment it reconnected. Synced in an
  // effect rather than assigned during render, which is a write to a value React may not have
  // committed yet.
  const load = React.useRef(onLoadMore);
  React.useEffect(() => {
    load.current = onLoadMore;
  }, [onLoadMore]);

  React.useEffect(() => {
    const node = ref.current;
    // jsdom has no IntersectionObserver, and neither do a few real browsers. The button above is
    // the whole fallback — no polyfill, no scroll listener.
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;

    const scroller = node.closest('.overflow-y-auto');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current?.();
      },
      { root: scroller ?? null, rootMargin: `${PREFETCH_MARGIN_PX}px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}
