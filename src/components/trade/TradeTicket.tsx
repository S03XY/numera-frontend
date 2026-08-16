'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import {
  formatAmount,
  formatPercent,
  formatSignedUsd,
  formatUnits,
  formatUsd,
  parseDecimalAmount,
  toBigInt,
} from '@/lib/format';
import type { Market } from '@/lib/api/types';
import { useSession } from '@/lib/auth/useSession';
import { queryKeys } from '@/lib/hooks/useMarkets';
import { useSubmitTrade, type SubmitTradeResult } from '@/lib/trade/useSubmitTrade';
import { useMarketHoldings } from '@/lib/hooks/usePositions';
import { predictTrade } from '@/lib/optimistic/predict';
import { usePool } from '@/lib/pool/PoolProvider';
import { useMarketAccountBalance } from '@/lib/execution/useMarketAccount';
import { useContractQuote, useMinTradeCost, type QuoteSide } from '@/lib/trade/useContractQuote';
import { useSharesForBudget } from '@/lib/trade/useSharesForBudget';
import { QUOTE_REFRESH_MS } from '@/lib/trade/refresh';
import { useSecond } from '@/lib/useNow';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { Datum } from '@/components/ui/primitives';
import { LiveBalance } from '@/components/ui/LiveBalance';

import { Explain } from '@/components/ui/Explain';
import { ShieldedAccount } from '@/components/ui/Shielded';
import { SealGlyph } from '@/components/ui/icons';
import { SETTLE_BEAT, ShieldingProgress } from './ShieldingProgress';
import { Bar, SettledMark, TraceMark } from '@/components/ui/Waiting';
import { outcomeVar, Ticking } from '@/components/markets/Outcomes';

/**
 * Said on every failure that rolled a prediction back.
 *
 * The panels move the instant a bet is placed, so a failure has to say the move was undone, or the
 * trader is left comparing an error message against a position that appears to exist.
 */
const UNDONE = 'The position and balance shown have been put back.';

/**
 * Two orthogonal choices, the way a prediction market is actually read.
 *
 * `Section` is what you are doing with money — putting it in or taking it out. `Position` is which
 * side of the outcome you are on: YES is long it, NO is short it. Collapsing these into one row of
 * buttons forces a trader to hold "buy the no" as a single compound idea; keeping them apart means
 * "Sell" and "No" each mean exactly one thing wherever they appear.
 *
 *   buy  + yes -> buy(i)              long the outcome
 *   buy  + no  -> buyComplement(i)    short it: one share of every other outcome
 *   sell + yes -> sell(i)             exit the long
 *   sell + no  -> sell every other leg exit the short
 */
type Section = 'buy' | 'sell';
type Position = 'yes' | 'no';

/** Turn a submission failure into something a trader can act on. */
function submitErrorCopy(result: Extract<SubmitTradeResult, { ok: false }>): string {
  switch (result.reason) {
    case 'no-position':
      return (
        result.message ??
        'None of your shielded accounts hold this outcome, so there is nothing to sell.'
      );
    case 'unfilled':
      return 'That size could not be filled against the current book.';
    case 'locked':
      return 'Unlock private trading first — your positions are held by shielded accounts.';
    case 'unavailable':
      return (
        result.message ??
        'Private trading is temporarily unavailable. Nothing was spent and your balance is ' +
          'untouched — please try again shortly.'
      );
    case 'pending':
      return (
        result.message ??
        'This is taking longer than usual to settle. It may still go through — check your ' +
          'portfolio before trying again.'
      );
    default:
      return result.message ?? 'The trade could not be submitted.';
  }
}

/**
 * Quick sizes, as a percentage of whatever is available.
 *
 * Percentages rather than fixed sizes because the two sides are bounded by different things — a
 * buy by the market balance, a sale by the position — and "50%" is the one label that means the
 * right thing on both. The last step is 100%, taken exactly rather than computed, so a full exit
 * closes the position with nothing stranded behind it.
 */
const PERCENT_STEPS = [25, 50, 75, 100] as const;

/** A percentage of a balance, floored — never rounded up past what is actually there. */
function portionOf(total: bigint, pct: number): bigint {
  return pct >= 100 ? total : (total * BigInt(pct)) / 100n;
}

/**
 * A WAD probability as money.
 *
 * One share settles at exactly 1 unit of collateral, so a marginal price of 0.6 is a share price
 * of $0.60. The same number in the notation a bettor reads.
 */
function perShare(priceWad: bigint, decimals: number): bigint {
  return (priceWad * 10n ** BigInt(decimals)) / 10n ** 18n;
}

/**
 * The section's colour: buy is green, sell is red.
 *
 * Two surfaces and no more: the tab and the commit button. Which way money is moving is then
 * answerable at a glance rather than by reading a word, without the colour bleeding into panels
 * that carry no direction.
 *
 * YES/NO keep their own green and red because they answer a different question: which way the
 * outcome goes. The two agree on "buy yes" and disagree on "buy no", and that disagreement is
 * the point — money going out, on a bet against.
 */
const TONE = {
  buy: { tab: 'border-pos bg-pos/10 text-pos', button: 'pos' },
  sell: { tab: 'border-neg bg-neg/10 text-neg', button: 'neg' },
} as const satisfies Record<Section, { tab: string; button: 'pos' | 'neg' }>;

/**
 * Buy/sell panel.
 *
 * ## Two directions, two units
 *
 * A buy is denominated in collateral and a sale in shares, because those are the two units the
 * trader already has in hand: money going in, a position coming out. The unknown half of the trade
 * is what the panel answers — shares received on a buy, dollars received on a sale.
 *
 * That asymmetry is not an inconsistency. A stake is a decision about money; an exit is a decision
 * about a position, and it has to be able to be exact, which a dollar-denominated exit never is.
 *
 * ## What binds and what is only shown
 *
 * The curve in `lib/lslmsr.ts` prices locally so the panel can show a spread, an average and the
 * price a trade leaves behind. None of that is committed to. The two numbers that go on chain —
 * the size and the guard on it — both come from the engine's own quotes: a buy's size is solved
 * from `quoteBuy` and capped at the budget itself, a sale's floor is derived from `quoteSell`.
 */
export function TradeTicket({
  market,
  onRequestFunds,
  blocked = false,
  onBusyChange,
}: {
  market: Market;
  /**
   * Ask the funding panel for a top-up of this many base units.
   *
   * Optional so the ticket still renders alone in tests and on any screen that has no funding
   * panel above it; when absent the shortfall is stated but cannot be acted on from here.
   */
  onRequestFunds?: (shortfall: bigint) => void;
  /**
   * A transfer is in flight on this market's shielded account, so no trade may start.
   *
   * The account permits one live session; a trade sent underneath a top-up is rejected at
   * prepare and reported a minute later as a failed bet. See `TradePanel`.
   */
  blocked?: boolean;
  /** Reports a trade starting and finishing, so the funding panel can stand down. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { status } = useSession();
  const { submit, needsUnlock, unavailable, paused, unlock } = useSubmitTrade(market);
  const { status: poolStatus } = usePool();
  const queryClient = useQueryClient();
  const [section, setSection] = React.useState<Section>('buy');
  const [position, setPosition] = React.useState<Position>('yes');
  const [outcomeIndex, setOutcomeIndex] = React.useState(0);
  const [amount, setAmount] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  /**
   * The bet landed, but the panel is still up.
   *
   * Held for {@link SETTLE_BEAT} so the veil can fill before it is replaced. Cutting the animation
   * off wherever it happened to be reads as the bet having been abandoned rather than completed —
   * which is the opposite of what just happened.
   */
  const [settling, setSettling] = React.useState(false);
  const [sessionStatus, setSessionStatus] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<{ txHash: string; account: string } | null>(null);
  const toast = useToast();

  const decimals = market.collateralDecimals;
  const sorted = React.useMemo(
    () => [...market.outcomes].sort((a, b) => a.index - b.index),
    [market.outcomes],
  );

  /**
   * The number in the box, in base units — but of *what* depends on the section.
   *
   * A buy is denominated in collateral, because that is the decision a bettor is actually making:
   * they put $50 on a team, and how many shares $50 buys is the curve's business rather than
   * theirs. A sale is denominated in shares, because shares are what they hold and a full exit has
   * to be exact — asking for "$30 back" always strands a remainder too small to close.
   *
   * So the unit flips with the tab, and the box is cleared when it does: leaving "50" in place
   * while it silently changes from fifty dollars to fifty shares is the one way this design can
   * hurt someone.
   *
   * Everything that costs a round trip reads the settled value rather than the live one. Sizing a
   * bet by budget means solving the cost curve against the chain, and without this every keystroke
   * of "50" would price a bet of 5 that nobody asked for.
   */
  const settledAmount = useDebouncedValue(amount, 300);
  const sizingStale = amount.trim() !== settledAmount.trim();
  const parsed = parseDecimalAmount(settledAmount, decimals);
  const size = parsed !== null && parsed > 0n ? parsed : null;
  const budget = section === 'buy' ? size : null;
  const sellShares = section === 'sell' ? size : null;

  /**
   * What this market's shielded account holds — the money this ticket actually spends.
   *
   * Not the private balance, which is what used to sit here. Collateral in the shielded pool
   * cannot reach the contracts directly; it has to be in this market's execution account first,
   * and quoting the pool figure here offered sizes the ticket could not fill. The panel above
   * moves value between the two.
   */
  const account = useMarketAccountBalance({
    marketRef: market.id,
    token: market.collateral,
    spender: market.address,
    enabled: poolStatus === 'ready',
  });

  const selected = sorted.find((o) => o.index === outcomeIndex) ?? sorted[0];
  const tone = TONE[section];
  const closed = !market.tradingOpen;

  /**
   * What this trader already holds, per outcome.
   *
   * Sizing a sale without it is guesswork: the ticket would happily quote a hundred shares
   * against a position of six and let the contract reject it with `InsufficientShares` after a
   * minute of shielding. The same figure makes a repeat buy legible — "I'm already long this."
   */
  const {
    sharesByOutcome,
    value: positionValue,
    basis: positionBasis,
  } = useMarketHoldings(market.id, account.balance > 0n);
  const held = sharesByOutcome.get(outcomeIndex) ?? 0n;

  /**
   * The NO position on this outcome.
   *
   * NO is one share of every OTHER outcome, so what is held — and what can be closed — is the
   * *smallest* leg. Selling more than that reverts on whichever leg runs out first, and the trader
   * would have no way to know which.
   */
  const noHeld =
    sorted.reduce<bigint | null>((min, o) => {
      if (o.index === outcomeIndex) return min;
      const legShares = sharesByOutcome.get(o.index) ?? 0n;
      return min === null || legShares < min ? legShares : min;
    }, null) ?? 0n;
  const sellable = position === 'yes' ? held : noHeld;

  /**
   * What one share costs on each side, as money.
   *
   * NO is the sum of every other outcome, not one minus this one. The marginal prices carry the
   * vig, so they add to slightly more than 1, and `1 − p` would understate what the NO side
   * actually costs by exactly the house edge — the last number to be casual about on a bet slip.
   */
  const yesPriceWad = toBigInt(selected?.priceWad) ?? 0n;
  const noPriceWad = sorted.reduce(
    (sum, o) => (o.index === outcomeIndex ? sum : sum + (toBigInt(o.priceWad) ?? 0n)),
    0n,
  );

  /**
   * The engine's floor, read from the chain because it is settable.
   *
   * Needed *before* a size is solved, not after: a budget that clears the floor must not be
   * quietly sized down below it by the slippage headroom.
   */
  const minTrade = useMinTradeCost(market.address, market.collateral);

  /**
   * The smallest budget this ticket will accept — the engine's floor plus a percent.
   *
   * Not the floor itself, and the difference is not fussiness. The floor bounds the trade's COST
   * from below and the budget caps it from above, so a bet of exactly the floor has to cost exactly
   * the floor to the base unit — a knife edge no discrete share count lands on. Offering it means
   * the trader types the very figure the panel called the minimum and watches it get refused.
   *
   * A percent above, and there is a band to land in. That percent is also the slippage room such a
   * bet gets, which is the smallest amount of room worth having.
   */
  const minBudget =
    minTrade === null || minTrade === 0n ? null : minTrade + (minTrade + 99n) / 100n;

  /**
   * The slippage tolerance, fixed at 1%.
   *
   * This was four buttons and a paragraph of explanation. On a buy it barely means anything any
   * more — the cap is the figure the trader typed, so the tolerance only decides how much of it
   * gets spent — and on a sale 1% is the ordinary default. A control that has to be explained
   * before it can be used, and that almost nobody should touch, is worth more as a sane constant.
   */
  const bps = 100n;

  /**
   * What to aim to spend on a buy.
   *
   * The cap is exactly what the trader typed — never a penny more, which is the only thing that
   * makes a "100%" button safe to offer against a balance. So the slippage tolerance comes *out*
   * of the budget rather than being added on top of it: the unspent remainder is what absorbs a
   * price move between this quote and the block that fills it.
   *
   * Floored at the engine's minimum whenever the budget itself clears it, because otherwise a bet
   * of exactly the minimum would be sized down by the headroom and then rejected on chain as below
   * it — the trader having typed the very figure the panel told them was allowed.
   */
  const target = React.useMemo(() => {
    if (budget === null) return null;
    const headroom = (budget * (10_000n - bps)) / 10_000n;
    const floor = minTrade !== null && minTrade > 0n && minTrade <= budget ? minTrade : 0n;
    return headroom > floor ? headroom : floor;
  }, [budget, bps, minTrade]);

  /**
   * The size a budget buys, solved against the engine's own quote.
   *
   * The engine is exact-output — it takes a share count and charges what the curve says — so
   * buying by dollar means inverting the cost function. See `useSharesForBudget` for why that
   * inversion lives here rather than in Solidity.
   */
  const solved = useSharesForBudget({
    engine: market.address,
    marketId: market.marketId,
    outcomeIndex,
    side: position === 'yes' ? 'buy' : 'short',
    budget,
    target,
    floor: minTrade ?? 0n,
    decimals,
    enabled: !closed && section === 'buy',
  });

  /**
   * The share count that actually goes on chain, whichever way the trade was sized.
   *
   * Gated on there being a size at all. The solve holds its previous answer while a new one is in
   * flight — without that the whole panel blinks between empty and priced on every keystroke — but
   * "previous" outlives the input being cleared, so an emptied box was still showing the last
   * quote: 12.59 shares for $9.90 over a field reading 0.00.
   */
  const sharesBase = section === 'buy' ? (budget === null ? null : solved.shares) : sellShares;
  /**
   * What a sale pays, from the engine — which is what its guard must be built from.
   *
   * The local `quote` is a good estimate and a bad guard: it excludes the trading fee, works in
   * doubles against the contract's fixed point, and the spread's time term moves under it. A floor
   * derived from it sits roughly a fee above what the engine actually pays, and the sale reverts —
   * which reads as "the price moved" when the two sides were never computing the same number.
   *
   * Buys no longer come through here at all: their size is solved from `quoteBuy` above, and their
   * guard is the trader's own budget.
   */
  const quoteSide: QuoteSide = position === 'yes' ? 'sell' : 'sellShort';
  const onChain = useContractQuote({
    engine: market.address,
    marketId: market.marketId,
    outcomeIndex,
    side: quoteSide,
    shares: sellShares,
    enabled: !closed && section === 'sell',
  });

  /** The money side of the trade: what a buy costs, or what a sale pays. Both fee-inclusive. */
  const total = section === 'buy' ? solved.cost : onChain.total;

  /**
   * The guard sent on chain.
   *
   * A buy sends the budget itself as `maxCost`. There is no percentage to get wrong and no way to
   * spend more than was typed: the trader's own figure is the one the contract enforces.
   *
   * A sale sends a floor under the proceeds, because a sale is sized in shares and it is the money
   * that varies. Rounded down, so rounding can never tighten the floor past the tolerance the
   * trader chose and revert a sale that was fine.
   */
  const guard =
    section === 'buy' ? budget : total === null ? null : (total * (10_000n - bps)) / 10_000n;

  /**
   * How much more this market's account needs before the trade can be placed.
   *
   * Only ever computed from a balance we actually read. An RPC that failed to answer leaves the
   * balance unknown, and treating unknown as zero would refuse a trade the trader can perfectly
   * well afford — so the shortfall is zero there and the funded path takes over as it always did.
   *
   * A sale needs no collateral at all: the shares are already with the account.
   */
  const balanceKnown = poolStatus === 'ready' && !account.unset && account.known;
  const shortfall =
    // Settled, never optimistic: a buy sized against a deposit that has not landed is a revert,
    // and Monad bills the declared gas limit whether a call succeeds or not.
    section === 'buy' && budget !== null && balanceKnown && budget > account.settledBalance
      ? budget - account.settledBalance
      : 0n;

  /**
   * The denominator the percentage buttons are a percentage *of*.
   *
   * Money on a buy, shares on a sale. Zero when the balance is merely unknown, which disables the
   * buttons rather than offering "100%" of a figure we have not actually read — a button that
   * fills in a number nobody can see the source of is worse than no button.
   */
  const quickBasis =
    section === 'sell' ? sellable : balanceKnown && !account.unset ? account.settledBalance : 0n;

  /**
   * Whether this trade clears the engine's floor.
   *
   * A buy is checked against the budget rather than the solved cost, so the answer arrives with
   * the keystroke instead of a round trip later — and it is the same answer, because `target` is
   * floored at the minimum whenever the budget clears it.
   *
   * A complete exit is exempt on chain, so a sale that closes the whole position is always allowed
   * however small — otherwise a position worth less than the floor could never be closed at all.
   */
  const isFullExit = section === 'sell' && sellable > 0n && sharesBase !== null && sharesBase >= sellable;
  const belowMinimum =
    minTrade !== null &&
    minTrade > 0n &&
    !isFullExit &&
    (section === 'buy'
      ? budget !== null && minBudget !== null && budget < minBudget
      : total !== null && total < minTrade);

  /**
   * There is an amount to price, and no price yet.
   *
   * Covers both halves of the wait, because a trader cannot tell them apart and should not have to:
   * the 300ms debounce while the typed figure settles, and the round trip that solves the size
   * against the engine. `sizingStale` catches the first, a missing quote the second.
   *
   * Read from the **live** box rather than from `budget` or `sellShares`, and that is the whole
   * subtlety: both of those are derived from the debounced value, so they are still null for the
   * first 300ms of every entry — which is precisely the window this exists to cover. Sizing it off
   * them produced a placeholder that appeared only after the part that felt slow was over.
   *
   * Deliberately silent on an empty or zero box. Nothing is being worked out there, and a
   * placeholder that appears before you have typed anything is noise rather than feedback.
   */
  const typed = parseDecimalAmount(amount, decimals);
  const pricing =
    !closed &&
    typed !== null &&
    typed > 0n &&
    (sizingStale || sharesBase === null || total === null);

  const canSubmit =
    status === 'authenticated' &&
    !closed &&
    // Never commit a size that was priced against a different number than the one now on screen.
    // Without this, typing 50 and then 500 inside the debounce window would send a bet sized for
    // fifty dollars under a five-hundred dollar cap.
    !sizingStale &&
    sharesBase !== null &&
    sharesBase > 0n &&
    guard !== null &&
    guard > 0n &&
    !belowMinimum &&
    shortfall === 0n;
  /** The market has been set up and has something to spend — the step-one work is done. */
  const funded = balanceKnown && !account.unset && account.balance > 0n;

  React.useEffect(() => {
    onBusyChange?.(submitting);
  }, [submitting, onBusyChange]);

  async function handleSubmit() {
    // Both numbers come from the same settled input, never from the live box — a buy sends the
    // size solved from the budget under a cap of the budget itself, a sale sends the shares typed
    // under a floor on the proceeds. Neither goes through float on the way.
    if (!canSubmit || sharesBase === null || guard === null) return;

    setSubmitting(true);
    setSessionStatus(null);

    /*
      Say what this will do before it is done, and take it back if it does not happen.

      The panels this bet changes — the position below, the balance above — are fed by our indexer
      and by a chain read, and neither knows anything until the transaction has landed. So the
      screen used to sit unchanged through the whole shielding sequence and then jump. The
      prediction is drawn immediately and holds until the server's own figures move; see
      `lib/optimistic/pending.ts` for why this is not a cache write.

      Registered before the await, not after, so the panel changes on the click rather than at the
      end of the part being covered up.
    */
    const revert = predictTrade({
      account: account.address,
      marketRef: market.id,
      token: market.collateral,
      balance: account.settledBalance,
      // Every outcome the trade touches. A YES is the one named; a NO is one share of each of the
      // others, which is the whole reason this is a list rather than an index.
      legs:
        position === 'yes'
          ? [outcomeIndex]
          : sorted.map((o) => o.index).filter((i) => i !== outcomeIndex),
      shares: sharesBase,
      // The quoted figure, not the guard. `guard` is the cap on a buy and the floor on a sale, so
      // using it would overstate what a buy spends and understate what a sale returns — visibly,
      // by the slippage tolerance, on the two numbers a trader is watching most closely.
      money: total ?? guard,
      side: section,
      held: sharesByOutcome,
      basis: positionBasis,
    });

    try {
      const result = await submit({
        market,
        outcomeIndex,
        // The four-way map, in one place. `short` is buy+no; a NO exit sells every other leg.
        side: section === 'buy' ? (position === 'yes' ? 'buy' : 'short') : 'sell',
        complement: position === 'no',
        size: sharesBase,
        onStatus: setSessionStatus,
        guard,
      });

      if (!result.ok) {
        // Taken back before the toast, so the numbers are already honest by the time the sentence
        // explaining them is read. A `pending` result keeps its prediction: the bet may yet land,
        // and pulling the position off screen would say it definitely did not.
        if (result.reason !== 'pending') revert();
        // The toast is the surface, not a second copy of an inline message: on a
        // long market page the ticket scrolls out of view, and a failed bet is
        // not something the user should have to go looking for.
        //
        // A pending result is NOT a failure — saying "not placed" would invite a
        // duplicate bet — so it gets the neutral tone and its own title.
        if (result.reason === 'pending') {
          toast.info('Still settling', submitErrorCopy(result));
        } else if (result.reason === 'unavailable') {
          // Titled by cause, not by consequence. "Your bet was not placed"
          // reads as a rejected trade and sends the user to re-check their
          // size or slippage, when in fact the trade was never offered.
          toast.error('Private trading unavailable', `${submitErrorCopy(result)} ${UNDONE}`);
        } else {
          toast.error('Your bet was not placed', `${submitErrorCopy(result)} ${UNDONE}`);
        }
        return;
      }
      setSettling(true);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BEAT));
      setReceipt({ txHash: result.txHash, account: result.account });
      setAmount('');
      // Prices and the tape arrive over the channel; refetch for the pool total.
      void queryClient.invalidateQueries({ queryKey: queryKeys.market(market.id) });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      // The stake has moved out of the market account and, on a sale, proceeds have moved back
      // into it. Both figures on the funding panel above are now stale.
      // `['execution', ...]` — see `MarketAccount.invalidateMoney`. The old key matched nothing.
      void queryClient.invalidateQueries({ queryKey: ['execution', 'market-account'] });
      void queryClient.invalidateQueries({ queryKey: ['unlink', 'balances'] });
    } catch (err) {
      // A throw is the one path that reaches here with the prediction still standing and no toast
      // written. `submit` returns its failures rather than raising them, so this is the unexpected
      // kind — and leaving a position on screen that nothing will ever confirm is the worst
      // available outcome, whatever went wrong.
      revert();
      toast.error(
        'Your bet was not placed',
        `${err instanceof Error ? err.message : 'Something went wrong.'} ${UNDONE}`,
      );
    } finally {
      setSubmitting(false);
      setSettling(false);
      setSessionStatus(null);
    }
  }

  return (
    <section className="plate p-4 sm:p-5">
      {/*
        Numbered only while the numbering is doing work.

        "Step 2" is the whole explanation of why a brand-new trader cannot press Buy yet: there is
        a step one, it is directly above, and the ticket is not broken. Once the market is funded
        that sentence has been read and understood, and a permanent "Step 2" over a panel with no
        visible step one is just noise — so it retires itself.
      */}
      <Explain
        label="How private trading works"
        right={
          <span className="inline-flex items-center gap-1.5 text-accent-bright">
            <SealGlyph className="size-2.5" />
            <span className="folio !text-accent-bright">Private</span>
          </span>
        }
        detail={
          <>
            <p>
              Your bet routes through this market’s shielded account. The market records the trade
              and the price move — never you.
            </p>
            <p className="text-ink-mute">
              YES buys the outcome. NO buys one share of every other outcome, which pays 1 per
              share exactly when the outcome you picked loses. Selling either closes it at the
              live price, before settlement, for whatever the curve will pay.
            </p>
          </>
        }
      >
        {funded ? 'Trade' : <span className="text-ink-mute">Step 2 · Trade</span>}
      </Explain>

      {/*
        The two figures a trader checks before doing anything: what this ticket can spend, and
        what they already have here. Stated once, at the top, on both tabs.

        The left-hand figure is the MARKET balance, not the private balance. They are different
        quantities and only one of them can pay for a bet — showing the pool figure here offered
        sizes the ticket had no way to fill. The private balance lives on the funding panel above,
        next to the control that moves it.
      */}
      <dl className="mt-3 grid grid-cols-2 border-b border-line pb-3">
        <div>
          <dt className="folio">Market balance</dt>
          <dd className="mt-1 text-[15px] text-ink">
            {poolStatus !== 'ready' ? (
              <span className="text-[12.5px] text-ink-mute">
                {poolStatus === 'unavailable' ? 'Unavailable' : 'Locked'}
              </span>
            ) : (
              <LiveBalance
                value={account.unset || account.isError ? null : account.balance}
                decimals={decimals}
                pending={account.isPending}
                placeholder={
                  <span className="text-[12.5px]">{account.unset ? 'Locked' : 'Unknown'}</span>
                }
                chars={6}
              />
            )}
          </dd>
        </div>
        <div className="border-l border-line pl-4">
          <dt className="folio">Your position</dt>
          <dd className="mt-1 text-[15px] text-ink">
            <LiveBalance
              value={positionValue > 0n ? positionValue : null}
              decimals={decimals}
              chars={6}
              /* The move, not a second copy of the value — the panel below breaks it down by
                 outcome, and repeating the same figure here would be the duplication this row
                 was rewritten to remove. */
              suffix={
                positionBasis > 0n ? (
                  <span
                    className={cn(
                      'ml-1.5 text-[11.5px]',
                      positionValue >= positionBasis ? 'text-pos' : 'text-neg',
                    )}
                  >
                    {formatSignedUsd(positionValue - positionBasis, decimals)}
                  </span>
                ) : null
              }
            />
          </dd>
        </div>
      </dl>

      <div className="mt-4 space-y-4">
        {/*
          Buy and Sell are SECTIONS, and YES/NO is the side of each outcome.

          They are different questions and they belong on different rows. "Buy" and "Sell" answer
          what happens to your money; "Yes" and "No" answer which way you think the outcome goes.
          Folding them into one strip of buttons — buy / short / sell — forced a trader to read
          "short" as a compound of both, which is exactly the confusion this layout removes.
        */}
        <div role="tablist" aria-label="Trade section" className="grid grid-cols-2 gap-px bg-line">
          {(['buy', 'sell'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={section === t}
              disabled={closed}
              // Cleared, because the unit changes with the tab: a buy is denominated in dollars
              // and a sale in shares. Leaving "50" in the box while it silently stops meaning
              // fifty dollars and starts meaning fifty shares is the one way this can hurt anyone.
              onClick={() => {
                setSection(t);
                setAmount('');
              }}
              // The transparent bottom border on the inactive tab reserves the same 2px the
              // active one paints, so switching sections does not nudge the panel.
              className={cn(
                'h-11 border-b-2 text-[12.5px] capitalize transition-colors disabled:opacity-40 sm:h-9',
                section === t
                  ? TONE[t].tab
                  : 'border-transparent bg-bg text-ink-mute hover:text-ink',
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/*
          Choosing an outcome, and choosing a side of it.

          The row itself is the control. It used to be inert scenery with two 54px chips at the
          far right as the only hit targets — so a trader who clicked the outcome's NAME, which is
          the obvious thing to click and the largest thing on the row, got nothing, and concluded
          the ticket was stuck on the first outcome. It was not stuck; it was unclickable
          everywhere it looked clickable.

          Now the label area is a real radio spanning all the free width, and the chips remain
          alongside it as the one-gesture "this outcome, this side" shortcut. Two controls rather
          than one because they answer two questions, and a selected row carries a solid rail so
          which one is live is answerable from the far side of the screen.
        */}
        <fieldset>
          <legend className="folio mb-2">Outcome</legend>
          <div role="radiogroup" aria-label="Outcome" className="grid gap-px bg-line">
            {sorted.map((o) => {
              const active = outcomeIndex === o.index;
              const label = o.label || `Outcome ${o.index + 1}`;
              return (
                /*
                  Stacked on a phone, side by side from `sm` up.

                  The two YES/NO chips are 54px each plus their gutter — around 138px of the row
                  that cannot give way. On a 320px screen that leaves about 110px for a colour
                  chip, an outcome name and a percentage, so "Argentina" arrived as "A…" and the
                  row stopped saying which outcome it was. Which is fatal: this row IS the choice.

                  Below `sm` the name and price take the full width and the two sides sit under
                  them as a pair of half-width targets — bigger than they have ever been on
                  desktop, on the surface where the thumb needs them to be.
                */
                <div
                  key={o.index}
                  className="flex flex-col gap-px bg-line sm:flex-row sm:items-stretch"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`Select ${label}`}
                    disabled={closed}
                    onClick={() => setOutcomeIndex(o.index)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors disabled:opacity-40',
                      active
                        ? 'border-accent-bright bg-accent-wash'
                        : 'border-transparent bg-bg hover:bg-bg-2',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.75 shrink-0"
                      style={{ background: outcomeVar(o.index) }}
                    />
                    <span
                      className={cn('truncate text-[13px]', active ? 'text-ink' : 'text-ink-dim')}
                    >
                      {label}
                    </span>
                    <Ticking
                      value={o.priceWad}
                      className="tabular shrink-0 text-[13px]"
                      style={{ color: outcomeVar(o.index) }}
                    >
                      {formatPercent(o.priceWad)}
                    </Ticking>
                    {/* No holdings here. This row has to fit a colour, a name, a price and two
                        side buttons inside a narrow column, and a share count was the thing that
                        pushed "Argentina" out to "A…". What is held is stated once, below the
                        prices, where it has a line to itself. */}
                  </button>

                  {/*
                    Yes carries the positive colour and No the negative one even when unselected,
                    so which is which is legible before you touch either.
                  */}
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 px-3 py-2 transition-colors sm:py-0',
                      active ? 'bg-accent-wash' : 'bg-bg',
                    )}
                  >
                    {(['yes', 'no'] as const).map((side) => {
                      const on = active && position === side;
                      return (
                        <button
                          key={side}
                          type="button"
                          aria-pressed={on}
                          aria-label={`${section} ${side} on ${label}`}
                          disabled={closed}
                          onClick={() => {
                            setOutcomeIndex(o.index);
                            setPosition(side);
                          }}
                          className={cn(
                            // Half the row each on a phone; the fixed 54px chip from `sm` up.
                            'mono h-10 flex-1 border px-3 text-[10px] uppercase tracking-[0.16em] transition-colors disabled:opacity-40 sm:h-auto sm:min-w-13.5 sm:flex-none sm:py-1.5',
                            on && side === 'yes' && 'border-pos bg-pos text-bg',
                            on && side === 'no' && 'border-neg bg-neg text-bg',
                            !on &&
                              side === 'yes' &&
                              'border-pos/30 text-pos hover:border-pos hover:bg-pos/10',
                            !on &&
                              side === 'no' &&
                              'border-neg/30 text-neg hover:border-neg hover:bg-neg/10',
                          )}
                        >
                          {side}
                        </button>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </fieldset>

        {/*
          No "BUY YES Argentina 78.8%" banner here.

          It restated three things already on screen an inch above it — the active tab, the
          highlighted outcome row, and that row's price — and it was the fourth block in a column
          that already had eight. What is about to happen is said once, at the point of commitment:
          the quote reads "49.5 YES shares" and "Pays if Argentina wins", and the button is green.
        */}
        {/*
          What a single share costs on each side.

          The percentage on the row above is the same number in the other notation, and for a
          contract that settles at exactly 1 the money form is the one that answers the question
          being asked: 60% is a probability, $0.60 is a price. Both sides are shown at once because
          choosing between them is the decision — reading one and subtracting is not.

          Two figures per cell and no more. Holdings used to sit in here as a third, which at this
          column width wrapped "per share" onto two lines and made the whole card read as rubble.
        */}
        <div className="grid grid-cols-2 gap-px bg-line">
          {(['yes', 'no'] as const).map((side) => {
            const on = position === side;
            return (
              <div
                key={side}
                className={cn('px-3 py-2 transition-colors', on ? 'bg-bg-2' : 'bg-bg')}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      'mono text-[10px] uppercase tracking-[0.16em]',
                      side === 'yes' ? 'text-pos' : 'text-neg',
                    )}
                  >
                    {side}
                  </span>
                  <span className="tabular text-[13px] text-ink">
                    {formatUsd(perShare(side === 'yes' ? yesPriceWad : noPriceWad, decimals), decimals, {
                      cents: true,
                    })}
                  </span>
                </div>
                <p className="folio mt-0.5">per share</p>
              </div>
            );
          })}
        </div>

        {/*
          What is held on this outcome, on one quiet line.

          It used to be a chip on each outcome row, where it competed with a colour, a name, a
          price and two side buttons for a narrow column — and lost, taking "Argentina" down to
          "A…" with it. Nothing here changes what the trader does next, so it goes small and last:
          it is a reminder of a position, not an input to the decision above it.

          Only what is actually held. A "0 NO" on every outcome nobody has shorted is noise that
          makes the one real holding harder to find.
        */}
        {(held > 0n || noHeld > 0n) && (
          <p className="folio">
            {`You hold ${[
              held > 0n ? `${formatAmount(held, decimals)} YES` : null,
              noHeld > 0n ? `${formatAmount(noHeld, decimals)} NO` : null,
            ]
              .filter(Boolean)
              .join(' · ')}`}
          </p>
        )}

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <label htmlFor="trade-amount" className="folio">
              {section === 'sell' ? 'Shares to sell' : 'Amount to spend (USDC)'}
            </label>
            {/*
              No figure here. Both denominators the percentage buttons work from are already on
              screen — the market balance at the top of this panel, and the per-side holdings in
              the YES/NO card directly above — and printing either one a second time in the same
              column is what this row used to do wrong.
            */}
          </div>
          <input
            id="trade-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="field tabular"
          />
          {/*
            Sized as a share of what is available, because that is the question being asked —
            "half my balance", not "plus ten shares". They set rather than add: a percentage of a
            balance is an absolute size, and adding 50% of a balance to whatever was already typed
            means nothing at all.
          */}
          <div className="mt-2 grid grid-cols-4 gap-px bg-line">
            {PERCENT_STEPS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={closed || quickBasis <= 0n}
                onClick={() => setAmount(formatUnits(portionOf(quickBasis, pct), decimals) ?? '')}
                className="mono h-10 bg-bg text-[10.5px] tracking-[0.1em] text-ink-mute transition-colors hover:text-ink disabled:opacity-40 sm:h-8"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/*
          The quote is being worked out.

          Nothing rendered here at all until the numbers arrived, so typing an amount produced a
          second or two of a page that had visibly not reacted — the debounce, then a round trip to
          solve the size against the engine's own curve. "It feels stuck" was the report, and the
          page really was doing nothing observable.

          Now the panel exists from the moment there is an amount to price, at the height it will
          settle at, so the layout does not jump when the figures land either.
        */}
        {pricing && (
          // One announced element, not two. The mark already carries the status role and the
          // label; making this wrapper a second status region with the same name announced the
          // whole thing twice. The bars below it are `aria-hidden` by construction.
          <div className="space-y-2.5 border border-line px-3 py-3">
            <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
              <span className="folio">Quote</span>
              <TraceMark label="Working out the price" className="size-4" />
            </div>
            {[
              { label: 22, value: 12 },
              { label: 14, value: 10 },
              { label: 18, value: 9 },
            ].map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-4 text-[13px]">
                <Bar chars={row.label} />
                <Bar chars={row.value} />
              </div>
            ))}
          </div>
        )}

        {sharesBase !== null && total !== null && (
          <dl className="space-y-2 border border-line px-3 py-3">
            <QuoteFreshness
              updatedAt={section === 'buy' ? solved.updatedAt : onChain.updatedAt}
              fetching={section === 'buy' ? solved.isFetching : onChain.isFetching}
              onRefresh={section === 'buy' ? solved.refetch : onChain.refetch}
            />
            {/*
              Four rows, and every one of them a number the person pressing the button cares about.

              It used to carry Spread, Avg price and Price after as well — three figures from a
              derivatives desk on what is, to the reader, a bet slip. The spread is stated once in
              the market's Details panel where it belongs, and the price the trade leaves behind is
              not a fact about their bet at all.

              The headline runs in whichever direction they are not already holding: buying, they
              named the money and the open question is the size; selling, the reverse.
            */}
            <Datum
              label="You receive"
              value={
                section === 'buy'
                  ? `${formatAmount(sharesBase, decimals)} ${position.toUpperCase()} shares`
                  : formatUsd(total, decimals, { cents: true })
              }
              strong
            />
            {section === 'buy' && (
              <Datum label="You pay" value={formatUsd(total, decimals, { cents: true })} />
            )}
            {/* What the fill actually costs per share, straight from the engine's own figures —
                no second pricing model needed to say it. */}
            <Datum
              label="Price per share"
              value={formatUsd((total * 10n ** BigInt(decimals)) / sharesBase, decimals, {
                cents: true,
              })}
            />
            {position === 'no' && (
              <p className="pt-1 text-[11px] text-ink-mute">
                {section === 'buy'
                  ? `One share of every other outcome — pays 1 each if ${
                      selected?.label || `outcome ${outcomeIndex + 1}`
                    } loses.`
                  : 'Closes every leg in one transaction.'}
              </p>
            )}
            {/*
              The payout, in money, because that is the line a bettor reads. A share settles at
              exactly 1, so the size IS the return — but leaving the reader to make that leap is
              the difference between a derivatives quote and a bet slip.
            */}
            {section === 'buy' && (
              <div className="border-t border-line pt-2">
                <Datum
                  label={`Pays if ${selected?.label || `outcome ${outcomeIndex + 1}`} ${
                    position === 'yes' ? 'wins' : 'loses'
                  }`}
                  value={formatUsd(sharesBase, decimals, { cents: true })}
                  strong
                />
              </div>
            )}
            {/*
              The guarantee, in one line, where the four-button slippage picker used to be. A buy
              cannot cost more than the figure typed; a sale has a floor under it.
            */}
            {guard !== null && (
              <p className="border-t border-line pt-2 text-[11px] text-ink-mute">
                {section === 'buy' ? 'Never spends more than ' : 'Reverts below '}
                <span className="tabular text-ink-dim">
                  {formatUsd(guard, decimals, { cents: true })}
                </span>
              </p>
            )}
          </dl>
        )}

        {submitting ? (
          <ShieldingProgress
            done={settling}
            status={sessionStatus}
            action={`${section === 'buy' ? 'Buying' : 'Selling'} ${position.toUpperCase()} on ${
              sorted[outcomeIndex]?.label || `outcome ${outcomeIndex + 1}`
            }`}
          />
        ) : receipt ? (
          <TradeReceipt receipt={receipt} section={section} onDone={() => setReceipt(null)} />
        ) : (
          <TradeAction
            canSubmit={canSubmit}
            blocked={blocked}
            closed={closed}
            notOpenYet={market.notOpenYet}
            authed={status === 'authenticated'}
            submitting={submitting}
            onSubmit={handleSubmit}
            needsUnlock={needsUnlock}
            unavailable={unavailable}
            paused={paused}
            onUnlock={() => void unlock()}
            section={section}
            tone={tone.button}
            shortfall={shortfall}
            belowMinimum={belowMinimum ? (section === 'buy' ? minBudget : minTrade) : null}
            decimals={decimals}
            onRequestFunds={onRequestFunds}
          />
        )}
      </div>
    </section>
  );
}

/**
 * How old this quote is, and when it will be re-read.
 *
 * ## Why a countdown rather than a spinner
 *
 * The figures in this panel come from the chain and they move. Without a clock the panel gives no
 * way to tell a number read a second ago from one read a minute ago, which on a market that has
 * just traded is the difference between a quote and a guess. A countdown answers "is this
 * current?" continuously and without being asked.
 *
 * It runs to zero and starts again rather than showing an age, because the useful question is
 * about the next read, not the last one: a trader deciding whether to wait wants to know how long
 * the wait is.
 *
 * The socket usually gets there first — a fill invalidates this immediately, so the countdown
 * resets early and often. That is the intended behaviour and it is worth seeing: a timer that
 * keeps jumping back to ten is the visible evidence that the book is live.
 */
function QuoteFreshness({
  updatedAt,
  fetching,
  onRefresh,
}: {
  /** Epoch ms of the last successful read; `0` before the first one. */
  updatedAt: number;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const now = useSecond();
  // `null` before hydration — the server has no clock, and a countdown rendered from one it
  // invented would be wrong on the first paint and then jump.
  const seconds = Math.round(QUOTE_REFRESH_MS / 1000);
  const remaining =
    now === null || updatedAt === 0
      ? null
      : // Clamped to the interval itself. `ceil` on the fraction of a second between the read
        // landing and the clock ticking rounds a ten-second wait up to eleven, and a countdown
        // that starts one above the number it always returns to reads as a glitch.
        Math.min(seconds, Math.max(0, Math.ceil((updatedAt + QUOTE_REFRESH_MS - now) / 1000)));

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
      <span className="folio">Quote</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={fetching}
        // A control, not a label: the countdown is the honest state and pressing it is the
        // impatient answer. Same target either way, so the row never reflows as it ticks.
        className="mono flex items-center gap-1.5 text-[10.5px] tracking-[0.14em] text-ink-mute uppercase transition-colors hover:text-ink disabled:opacity-60"
      >
        <span aria-hidden="true" className={cn('size-1.5', fetching ? 'bg-accent-bright' : 'bg-line-2')} />
        {fetching || remaining === null ? 'Updating' : `${remaining}s`}
      </button>
    </div>
  );
}

function TradeAction({
  canSubmit,
  blocked,
  closed,
  notOpenYet,
  authed,
  submitting,
  onSubmit,
  needsUnlock,
  unavailable,
  paused,
  onUnlock,
  section,
  tone,
  shortfall,
  belowMinimum,
  decimals,
  onRequestFunds,
}: {
  canSubmit: boolean;
  /** A transfer is settling on this market's shielded account; no trade may start. */
  blocked: boolean;
  closed: boolean;
  /** Scheduled, but the book has not opened. A different sentence from closed, and a truer one. */
  notOpenYet: boolean;
  authed: boolean;
  submitting: boolean;
  onSubmit: () => void;
  needsUnlock: boolean;
  unavailable: boolean;
  /** Sponsored gas is off, so nobody can bet right now. Ours to explain, not theirs to fix. */
  paused: 'disabled' | 'capped' | null;
  /** Base units this market's account is short by, or `0n` when it can cover the trade. */
  shortfall: bigint;
  /** The engine's floor when this trade is under it, else `null`. */
  belowMinimum: bigint | null;
  decimals: number;
  onRequestFunds?: (shortfall: bigint) => void;
  onUnlock: () => void;
  section: Section;
  /** Green for buy, red for sell — carried only by the button that actually trades. */
  tone: 'pos' | 'neg';
}) {
  if (closed) {
    /*
      Two reasons a book takes no bets, and they are not the same news.

      "Trading closed" on a market that opens on Friday reads as "you missed it", and it is the
      opposite. The engine distinguishes them too — a trade before the start reverts with
      `MarketNotOpenYet` — so the button says which one it is.
    */
    return (
      <Button disabled className="w-full" size="lg">
        {notOpenYet ? 'Not open yet' : 'Trading closed'}
      </Button>
    );
  }

  // Checked before everything else: while a transfer is settling, no other state of this button
  // is actionable, and offering "Buy" would queue a trade destined to be rejected at prepare.
  if (blocked) {
    return (
      <div className="space-y-2">
        <Button disabled className="w-full" size="lg">
          Finishing your transfer…
        </Button>
        <p className="text-[11px] text-ink-mute">
          This market’s shielded account runs one operation at a time.
        </p>
      </div>
    );
  }
  if (!authed) {
    return (
      <Button disabled className="w-full" size="lg">
        Sign in to trade
      </Button>
    );
  }

  // Say so plainly rather than offering an unlock that leads nowhere.
  if (unavailable) {
    return (
      <>
        <Button disabled className="w-full" size="lg">
          Private trading unavailable
        </Button>
        <p role="note" className="border border-line px-3 py-2.5 text-[11px] leading-relaxed text-ink-mute">
          This deployment has no privacy layer configured, so bets cannot be placed.
        </p>
      </>
    );
  }

  /*
    Nobody can bet right now, and it is not this trader's doing.

    Above the unlock, deliberately: a passkey prompt that ends in a paused relayer is a prompt
    spent on nothing. Below the privacy-layer check, because that one is the deeper fact — a
    deployment with no privacy layer cannot bet whatever the relayer is doing.

    The two causes get different sentences because the next move differs. A spent budget resolves
    itself overnight; a deployment with no relayer never will.
  */
  if (paused) {
    return (
      <>
        <Button disabled className="w-full" size="lg">
          Betting is paused
        </Button>
        <p role="note" className="border border-line px-3 py-2.5 text-[11px] leading-relaxed text-ink-mute">
          {paused === 'capped'
            ? 'Numera pays the network fee on every bet, and today’s budget is spent. Betting opens again tomorrow. Nothing has been taken from your balance, and your positions are unaffected.'
            : 'Sponsored betting is not configured on this deployment, so bets cannot be placed.'}
        </p>
      </>
    );
  }

  // Offer the unlock up front rather than letting the user fill in a size and
  // then bounce off an error. Trading needs the shielded key; signing in does not.
  //
  // Deliberately the brand primary, not the section tone: unlocking is not a direction, and a
  // green button here would read as "buy" before any size has been entered.
  if (needsUnlock) {
    return (
      <div className="space-y-2">
        <Button variant="primary" size="lg" onClick={onUnlock} className="w-full">
          Unlock private trading
        </Button>
        <p className="text-[11px] text-ink-mute">One passkey touch per session.</p>
      </div>
    );
  }

  if (belowMinimum !== null) {
    return (
      <div className="space-y-2">
        <Button variant="primary" size="lg" className="w-full" disabled>
          {`Minimum bet is ${formatUsd(belowMinimum, decimals, { cents: true })}`}
        </Button>
        <p className="text-[11px] text-ink-mute">
          Numera covers the network fee on every bet, so each one has to be worth more than the fee
          it costs to place. Increase the size to continue.
        </p>
      </div>
    );
  }

  /**
   * The trade costs more than this market's account holds.
   *
   * Deliberately not a disabled button with a message beside it. The trader's next action is
   * known exactly — deposit this much — so the button becomes that action and carries the figure,
   * which the funding panel above then receives pre-filled. A dead "Buy" and a separate sentence
   * asking them to work out the difference is the version of this that sends people away.
   */
  if (shortfall > 0n) {
    return (
      <div className="space-y-2">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!onRequestFunds}
          onClick={() => onRequestFunds?.(shortfall)}
        >
          {`Add ${formatUsd(shortfall, decimals)} to trade`}
        </Button>
        {/* Kept on the surface: this one names the next action, it does not explain the model. */}
        <p className="text-[11px] text-ink-mute">
          {`${formatUsd(shortfall, decimals)} short — top up above.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant={tone}
        size="lg"
        disabled={!canSubmit || submitting}
        onClick={onSubmit}
        className="w-full"
      >
        {submitting ? 'Confirming…' : section === 'buy' ? 'Buy privately' : 'Sell privately'}
      </Button>
    </div>
  );
}

/**
 * Post-trade confirmation.
 *
 * Naming the fresh execution account is the point: it is the moment the privacy
 * model stops being marketing copy and becomes something the user can see.
 *
 * ## The loop closes here
 *
 * A private bet takes tens of seconds, and for all of them the panel above this
 * one has been drawing a loop. This panel does not introduce an animation over
 * the top of that: it **finishes** it. {@link ShieldingProgress} leaves the arc
 * at `SETTLED_AT`, and `.circuit-arc` opens on exactly that offset, so the
 * last quarter snaps shut, the join sparks, the mark fills, and the panel throws
 * the light off its edge. Two panels, one gesture.
 *
 * The copy behind it is staggered rather than arriving with the mark, because a
 * receipt that lands complete has nothing to look at: the eye has already read
 * it before the animation has finished saying anything.
 */
function TradeReceipt({
  receipt,
  section,
  onDone,
}: {
  receipt: { txHash: string; account: string };
  section: Section;
  onDone: () => void;
}) {
  return (
    <div className="circuit-panel border border-accent-dim bg-accent-wash p-3.5">
      {/*
        The pulse off the border, timed to leave as the loop shuts. Two rings rather than one: a
        single expanding box reads as a box, and two read as a shock.
      */}
      <span className="circuit-pulse" style={{ animationDelay: '330ms' }} aria-hidden="true" />
      <span className="circuit-pulse" style={{ animationDelay: '450ms' }} aria-hidden="true" />

      <div className="flex items-center gap-2.5">
        <SettledMark className="size-8" />
        {/* An exit is not a bet placed. Saying so after a sell invited a second look at the
            portfolio to check nothing had been opened by mistake. */}
        <span className="folio settle-in !text-accent-bright" style={{ animationDelay: '420ms' }}>
          {section === 'buy' ? 'Bet placed privately' : 'Position closed privately'}
        </span>
      </div>

      <dl className="settle-in mt-3 space-y-2" style={{ animationDelay: '520ms' }}>
        <Datum label="Executed by" value={<ShieldedAccount address={receipt.account} />} />
        <Datum
          label="Transaction"
          value={
            <span className="mono text-[11.5px]">
              {receipt.txHash.slice(0, 6)}…{receipt.txHash.slice(-4)}
            </span>
          }
        />
      </dl>

      <div className="settle-in" style={{ animationDelay: '620ms' }}>
        <Button variant="ghost" size="sm" onClick={onDone} className="mt-3 w-full">
          Place another
        </Button>
      </div>
    </div>
  );
}
