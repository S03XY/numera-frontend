'use client';

import * as React from 'react';
import type { Market } from '@/lib/api/types';
import { formatUnits } from '@/lib/format';
import { MarketAccount } from './MarketAccount';
import { TradeTicket } from './TradeTicket';

/**
 * The two halves of trading a market, in the order they happen.
 *
 * Funding comes first because it has to: collateral cannot reach the contracts except through
 * this market's execution account, and until it does there is nothing for the ticket to spend.
 * Stacking them makes that sequence the layout rather than a rule the trader has to know.
 *
 * The one thing they share is the deposit amount, held here. When a bet costs more than the
 * market balance covers, the ticket does not simply refuse — it names the shortfall and puts it
 * in the funding field above, so "you need more" and "here is how much" are one gesture instead
 * of a dead end and some mental arithmetic.
 *
 * ## Once the book shuts
 *
 * The ticket goes away rather than greying out. It used to stay, with every control disabled and a
 * dead button reading "Trading closed", which is a whole panel of prices, tabs and amount fields
 * spent on saying "no" — and it sat where the answer belongs. A market that has closed has exactly
 * two things left to tell you: what it settled to, and what you are owed. Neither is here.
 *
 * The funding panel stays, and has to. It is where a resolution bond is paid from, and it is the
 * only way the balance in this market's account gets back out. Money can still move after close;
 * it just cannot be bet.
 */
export function TradePanel({ market }: { market: Market }) {
  const [fundAmount, setFundAmount] = React.useState('');
  const headingRef = React.useRef<HTMLDivElement>(null);

  /**
   * One execution account, one operation at a time — so the two panels take turns.
   *
   * Funding and trading on a market both run through the *same* shielded account, and Unlink
   * permits it a single live session. Nothing stopped a trader pressing Add and then Buy: the
   * second was rejected at prepare with "execution account already has an active execution
   * session", spun through the retry schedule, and surfaced a minute later as an error about a
   * trade that was never offered. Both panels are on screen together, so this is an ordinary
   * thing to do rather than an edge case.
   *
   * Held here because it is a fact about the pair, not about either one.
   */
  const [funding, setFunding] = React.useState(false);
  const [trading, setTrading] = React.useState(false);

  const requestFunds = React.useCallback(
    (shortfall: bigint) => {
      // Rounded UP to the whole unit. Depositing the exact shortfall leaves an account that
      // covers this trade and nothing else, and the price will have moved by the time the
      // transfer lands — so the amount that was exactly enough is then a penny short.
      const decimals = market.collateralDecimals;
      const unit = 10n ** BigInt(decimals);
      const rounded = ((shortfall + unit - 1n) / unit) * unit;
      setFundAmount(formatUnits(rounded, decimals) ?? '');
      headingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    [market.collateralDecimals],
  );

  return (
    <div className="space-y-4">
      {/*
        `scroll-mt` so the panel this scrolls to is not parked under the sticky masthead.

        `block: 'nearest'` treats the top of the viewport as the top of the page, and the header
        covers the first four rem of it — so on a phone, where the funding panel is taller than
        the screen, "add this much" landed the trader on a heading they could not see. The header
        is the same height on every route, so this is a constant rather than a measurement.
      */}
      <div ref={headingRef} className="scroll-mt-20">
        <MarketAccount
          market={market}
          amount={fundAmount}
          onAmountChange={setFundAmount}
          blocked={trading}
          onBusyChange={setFunding}
        />
      </div>
      {market.tradingOpen && (
        <TradeTicket
          market={market}
          onRequestFunds={requestFunds}
          blocked={funding}
          onBusyChange={setTrading}
        />
      )}
    </div>
  );
}
