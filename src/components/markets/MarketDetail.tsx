'use client';

import * as React from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api/errors';
import { formatDateTime, formatUsd } from '@/lib/format';
import { categoryDisplay } from '@/lib/categories';
import { useMarket, useMarketTradesPages } from '@/lib/hooks/useMarkets';
import { useMarketChannel } from '@/lib/realtime/useMarketChannel';
import { ErrorState } from '@/components/ui/Feedback';
import { Datum, Folio, SectionHead, StatusDot } from '@/components/ui/primitives';
import { PrivacyMark } from '@/components/ui/Shielded';
import { TradePanel } from '@/components/trade/TradePanel';
import { MarketStatus } from './MarketCard';
import { CloseClock, Countdown } from './Countdown';
import { MarketPosition } from './MarketPosition';
import { Distribution, OddsBar } from './Outcomes';
import { PriceChart } from './PriceChart';
import { ResolutionPanel } from './ResolutionPanel';
import { ResolutionRules } from './ResolutionRules';
import { TradeTape } from './TradeTape';
import { Bar, BarStack, useDelayedFlag } from '@/components/ui/Waiting';

export function MarketDetail({ marketId }: { marketId: string }) {
  const { data: market, isPending, isError, error, refetch } = useMarket(marketId);
  const tape = useMarketTradesPages(marketId);
  const { connected, liveTrades } = useMarketChannel(market?.id);

  // Flattened here rather than in the tape, which takes a plain array so it stays renderable from
  // a fixture — the pagination is this screen's concern, not the table's.
  const fills = React.useMemo(
    () => tape.data?.pages.flatMap((page) => page.items),
    [tape.data],
  );
  const showLoading = useDelayedFlag(isPending);

  if (isPending) {
    // Reserve the height either way, so the page does not jump when the
    // placeholder appears a beat later.
    if (!showLoading) return <div className="min-h-[60vh]" aria-busy="true" />;
    return (
      <div className="space-y-5" role="status" aria-label="Loading market">
        <span className="block text-[11px]">
          <Bar chars={14} />
        </span>
        <span className="block text-[28px] leading-tight">
          <Bar chars={26} />
        </span>
        <span className="block text-[14px]">
          <Bar chars={34} />
        </span>
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="plate p-5">
            <BarStack lines={[30, 26, 22, 28, 18, 24]} label="Loading the book" />
          </div>
          <div className="plate p-5">
            <BarStack lines={[22, 18, 26, 14]} label="Loading the ticket" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !market) {
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <ErrorState
        title={notFound ? 'Market not found' : 'Couldn’t load this market'}
        description={error instanceof ApiError ? error.userMessage : 'Please try again in a moment.'}
        onRetry={notFound ? undefined : () => void refetch()}
      />
    );
  }

  const { blurb } = categoryDisplay(market.category);
  const sorted = [...market.outcomes].sort((a, b) => a.index - b.index);

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/" className="link-rule folio hover:text-ink">
            ← Markets
          </Link>
          <span aria-hidden="true" className="text-ink-mute">
            /
          </span>
          <Folio>{market.category ?? 'Market'}</Folio>
          {/* The settled and void seals still belong up here. The live countdown does not, and has
              moved to the clock beside the title, where a deadline you are trading against reads
              as a deadline rather than as breadcrumb metadata. */}
          {!market.tradingOpen && <MarketStatus market={market} />}
          <PrivacyMark className="ml-auto" />
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <h1 className="h-sec max-w-[24ch]">{market.title || 'Untitled market'}</h1>
            <p className="mt-2.5 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-dim">
              {market.description || blurb}
            </p>
          </div>
          {/* A settled market has no clock worth drawing. "Trading closed, 00:00" is true and
              spent, and the seal in the breadcrumb already says so — the result itself now leads
              the column beside this. Kept while a closed market is still waiting on a result,
              where "the book is shut" is genuinely the state. */}
          {market.status === 'TRADING' && (
            <CloseClock target={market.closeTime} closed={!market.tradingOpen} />
          )}
        </div>

        <ResolutionRules market={market} />
      </header>

      {/*
        Two independent columns, not a grid of rows.

        This was a 2×2 grid with each group pinned to a row and a column, and row sizing is what
        broke it: row one is as tall as its tallest member, and the trade column — funding, ticket,
        position — is far taller than prices plus a chart. So the tape, pinned to row two, began
        level with the bottom of the ticket and left several hundred pixels of nothing under the
        price history.

        Columns that flow independently cannot do that. The cost is that document order is now
        column order, so the tape sits between the chart and the ticket in the markup and `order`
        moves it back below once the layout collapses to one column. Worth it here specifically
        because the tape holds no focusable elements — it is a list of trades — so nothing about
        keyboard order changes, and it carries its own heading for anyone navigating by landmark.
      */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1fr_360px] lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <section className="plate p-4 sm:p-5">
            {/* Nothing about a settled market is live. The socket is still connected and still
                says so, which is a fact about our plumbing rather than about this market, and
                next to a frozen set of odds it reads as a claim that they are still moving. */}
            <SectionHead
              right={
                market.status === 'TRADING' ? (
                  <span className="inline-flex items-center gap-2">
                    <StatusDot live={connected} />
                    <span className="folio">{connected ? 'Live' : 'Reconnecting'}</span>
                  </span>
                ) : (
                  <Folio>Final</Folio>
                )
              }
            >
              {market.status === 'TRADING' ? 'Market prices' : 'Closing prices'}
            </SectionHead>

            <Distribution outcomes={sorted} className="mt-3.5" height={4} />

            <div className="mt-3.5 space-y-2">
              {sorted.map((o) => (
                <OddsBar key={o.index} outcome={o} />
              ))}
            </div>
          </section>

          <PriceChart market={market} />

          {/* Last on a phone, so nobody scrolls past every fill to reach the thing they came for. */}
          <section className="plate order-last p-4 sm:p-5 lg:order-none">
            <SectionHead right={<Folio>Traders are shielded</Folio>}>Trade activity</SectionHead>
            <div className="mt-3.5">
              <TradeTape
                market={market}
                trades={fills}
                liveTrades={liveTrades}
                hasMore={tape.hasNextPage}
                loadingMore={tape.isFetchingNextPage}
                onLoadMore={() => void tape.fetchNextPage()}
              />
            </div>
          </section>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-4">
          {/*
            The column reorders itself the moment the book shuts.

            While trading is open the ticket leads, because placing a bet is what the page is for.
            Once it closes that is no longer true and the ranking inverts: the result, then what
            you are owed, then the account the money moves through. Leaving the funding panel on
            top after settlement puts a deposit field above the answer to the question the market
            asked, which is the wrong thing to look at and the wrong thing to press.
          */}
          {market.tradingOpen ? (
            <>
              {/* Funding then trading, in that order, because that is the order they happen. */}
              <TradePanel market={market} />
              {/* Directly under the ticket, so the result of a bet is where the bet was placed. */}
              <MarketPosition market={market} />
            </>
          ) : (
            <>
              <ResolutionPanel market={market} />
              <MarketPosition market={market} />
              <TradePanel market={market} />
            </>
          )}

          <section className="plate p-4 sm:p-5">
            <SectionHead>Details</SectionHead>
            <dl className="mt-3.5 space-y-2">
              <Datum label="Pool" value={formatUsd(market.pot, market.collateralDecimals)} strong />
              {/* No "Pricing: Damped LS-LMSR" row. It named the algorithm to someone placing a
                  bet, which tells them nothing they can act on and reads as jargon on a betting
                  slip. What the curve actually costs them is the spread, and that stays. */}
              <Datum label="Spread" value="0.5%–2.5%, widening toward close" />
              <Datum label="Outcomes" value={String(market.outcomeCount)} />
              {/* Only worth a row while it is still ahead. Every market has a start time — the
                  engine substitutes the creation block when a creator does not name one — so
                  rendering it unconditionally would put "Opens: <the past>" on every market. */}
              {market.notOpenYet && (
                <Datum
                  label="Opens"
                  value={
                    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
                      <span>{formatDateTime(market.startTime)}</span>
                      <Countdown target={market.startTime} alwaysTicking className="text-ink" />
                    </span>
                  }
                  strong
                />
              )}
              <Datum
                label="Closes"
                value={
                  <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
                    <span>{formatDateTime(market.closeTime)}</span>
                    {market.tradingOpen && (
                      <Countdown target={market.closeTime} alwaysTicking className="text-ink" />
                    )}
                  </span>
                }
              />
            </dl>
          </section>
          {/* No resolution panel down here any more: it has nothing to say while the book is open,
              and once it shuts it leads this column instead. */}
        </div>
      </div>
    </div>
  );
}
