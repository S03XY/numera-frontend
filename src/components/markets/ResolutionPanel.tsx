'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { formatUsd, toBigInt } from '@/lib/format';
import type { Market, Resolution, ResolutionTerms } from '@/lib/api/types';
import { useResolutionTerms } from '@/lib/hooks/useMarkets';
import { useResolutionActions } from '@/lib/execution/useResolution';
import { Button } from '@/components/ui/Button';
import { TraceMark, Waiting } from '@/components/ui/Waiting';
import { useMarketAccountBalance } from '@/lib/execution/useMarketAccount';
import { Datum } from '@/components/ui/primitives';
import { Explain } from '@/components/ui/Explain';
import { ShieldedAccount } from '@/components/ui/Shielded';
import { ResolutionRules } from './ResolutionRules';
import { outcomeVar } from './Outcomes';
import { useToast } from '@/components/ui/Toast';

/**
 * How this market settles, and where it has got to.
 *
 * ## Why a trader can press something here
 *
 * An earlier version of this panel was read-only, on the argument that proposing an outcome from
 * your own wallet tells everyone which side you hold. That argument was right about the leak and
 * wrong about the conclusion. The proposal does not have to come from your wallet: it comes from
 * the same shielded market account that placed your bets, relayed by us, paying no gas. The
 * proposer stays inside the anonymity set the trades are already in, so there is nothing left to
 * leak — and settlement stops being something only the operator can start.
 *
 * ## What the money is doing
 *
 * A proposal stakes a flat bond, the same on every market, so a proposer knows the cost before
 * opening the page. If nobody objects inside the window, the proposer takes the stake back plus a
 * share of what the market earned in fees. If somebody objects, the quorum rules, and whichever
 * side asserted a falsehood forfeits its stake and loses the right to trade.
 *
 * The operator can also propose, without a bond. That buys speed, not finality: an operator's
 * proposal opens exactly the same window, and can be challenged on exactly the same terms.
 */
export function ResolutionPanel({ market }: { market: Market }) {
  // Nothing to say while the book is still open.
  if (market.status === 'TRADING' && market.tradingOpen) return null;
  return <Panel market={market} />;
}

/**
 * A wire amount as a number, treating anything unparseable as zero.
 *
 * `toBigInt` returns null for a missing or malformed figure, which is right for it and wrong here:
 * every use below is an amount to display or to size an approval with, and a null propagating into
 * either produces a blank where a number belongs or an approval of `undefined`.
 */
function amount(value: string | null | undefined): bigint {
  return toBigInt(value) ?? 0n;
}

type Stage = 'awaiting' | 'proposed' | 'disputed' | 'ready' | 'settled' | 'void';

function stageOf(market: Market): Stage {
  if (market.status === 'RESOLVED') return 'settled';
  if (market.status === 'INVALID') return 'void';
  const r = market.resolution;
  if (!r || r.phase === 'NONE' || r.phase === 'SETTLED') return 'awaiting';
  if (r.phase === 'DISPUTED') return 'disputed';
  return r.finalizable ? 'ready' : 'proposed';
}

const STAGE: Record<Stage, { label: string; tone: string }> = {
  awaiting: { label: 'Awaiting a result', tone: 'text-ink-dim' },
  proposed: { label: 'Result proposed', tone: 'text-accent' },
  ready: { label: 'Ready to settle', tone: 'text-accent' },
  disputed: { label: 'Disputed', tone: 'text-warn' },
  settled: { label: 'Settled', tone: 'text-pos' },
  void: { label: 'Voided', tone: 'text-ink-dim' },
};

function Panel({ market }: { market: Market }) {
  const stage = stageOf(market);
  const live = stage === 'awaiting' || stage === 'proposed' || stage === 'ready';
  const terms = useResolutionTerms(market.id, live);
  const t = terms.data?.available ? terms.data : null;

  const label = (index: number | null) =>
    index === null
      ? 'Void, refunding everyone'
      : (market.outcomes.find((o) => o.index === index)?.label ?? `Outcome ${index + 1}`);

  return (
    <section className="plate p-4 sm:p-5">
      <Explain
        label="How this market settles"
        right={<span className={cn('folio', STAGE[stage].tone)}>{STAGE[stage].label}</span>}
        detail={
          <>
            <p>
              Anyone can propose the result once trading closes, by staking a bond. If nobody
              disputes it inside the window, it settles and the proposer gets the stake back plus a
              share of what this market earned in fees.
            </p>
            <p className="text-ink-mute">
              Anyone can dispute a proposal, by staking the same amount. A dispute goes to the
              operator&rsquo;s signer quorum, and whichever side asserted a falsehood forfeits its
              stake and loses the right to trade here.
            </p>
            <p className="text-ink-mute">
              Your proposal is sent from the same shielded account that placed your bets, so taking
              part reveals nothing about which side you hold. The operator can also propose, without
              a bond. That only makes settlement quicker, never final: its proposal is open to the
              same challenge as anyone else&rsquo;s.
            </p>
          </>
        }
      >
        Resolution
      </Explain>

      {/* Open, not collapsed. Everywhere else this is reference material; here it is the thing
          being argued about, and somebody is about to put money behind their reading of it. */}
      <ResolutionRules market={market} defaultOpen className="border-line" />

      {market.resolution && <Standing resolution={market.resolution} label={label} />}

      {(stage === 'settled' || stage === 'void') && <Result market={market} label={label} />}

      {stage === 'awaiting' && <ProposeForm market={market} terms={t} loading={terms.isLoading} />}
      {stage === 'proposed' && <DisputeForm market={market} terms={t} label={label} />}
      {/*
        Settling, not "somebody could settle".

        This used to say that anyone could now complete the settlement on chain, which was true and
        useless: it named a step, gave the reader no way to take it, and left a winner staring at a
        market that had stopped one transaction short of paying them. The platform sends that
        transaction now (see the backend's settlement service), so the honest thing to report is
        that it is happening, with the mark that means work is in flight.
      */}
      {stage === 'ready' && (
        <div className="mt-4 flex items-start gap-3 border-t border-line pt-4">
          <TraceMark label="Settling this market" className="mt-px size-5" />
          <p className="text-[13px] text-ink-dim">
            Nobody challenged the result, so this market is being settled now. It takes a moment.
            Winning shares can be collected as soon as it lands.
          </p>
        </div>
      )}
      {stage === 'disputed' && (
        <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-mute">
          Two people have staked against each other on this result. The operator&rsquo;s signer
          quorum decides it, and the side that was wrong forfeits its stake.
        </p>
      )}
    </section>
  );
}

/**
 * The answer, once there is one.
 *
 * This was a `Datum` row reading "Outcome — Yes", the same weight as "Spread" and "Pool" two panels
 * up. It is the question the market was asking and the reason anybody is on the page after the
 * book shuts, so it is drawn as the answer to that question and not as an attribute of it.
 *
 * The winning label carries the outcome's own colour, the one it has worn on every bar and every
 * row on this page since it opened, so the eye recognises it before the words are read.
 */
function Result({
  market,
  label,
}: {
  market: Market;
  label: (index: number | null) => string;
}) {
  const winner = market.winningOutcomeId;
  // One value, not a flag plus a nullable index: `won === null` *is* the void case, so the two
  // cannot drift apart and the colour swatch below narrows without a second assertion.
  const won = market.status === 'INVALID' ? null : winner;
  const void_ = won === null;
  const route = market.resolution?.route;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="folio">{void_ ? 'This market was voided' : 'This market settled on'}</p>
      <p
        className="mt-1.5 flex items-center gap-2.5 text-[22px] leading-none text-ink sm:text-[26px]"
        // One announcement, in a sentence, rather than the eye's version read out as fragments.
        aria-label={
          won === null
            ? 'This market was voided and every trader is refunded'
            : `This market settled on ${label(won)}`
        }
      >
        {won !== null && (
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0"
            style={{ background: outcomeVar(won) }}
          />
        )}
        <span aria-hidden="true">{won === null ? 'Refunded' : label(won)}</span>
      </p>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-dim">
        {void_
          ? 'The question could not be settled honestly, so nobody won and everybody gets back what they put in.'
          : 'Shares of this outcome are worth 1 each. Everything else is worth nothing.'}
        {route === 'ARBITRATED'
          ? ' It was decided by the operator quorum, after somebody disputed the proposed result.'
          : route === 'FINALIZED'
            ? ' Nobody disputed the proposed result inside the challenge window.'
            : ''}
      </p>
    </div>
  );
}

/** The standing proposal, whatever stage it is at. Facts only. */
function Standing({
  resolution: r,
  label,
}: {
  resolution: Resolution;
  label: (index: number | null) => string;
}) {
  if (r.phase === 'NONE') return null;
  return (
    <dl className="mt-4 space-y-2 border-t border-line pt-4">
      <Datum label="Proposed result" value={label(r.proposedOutcome)} strong />
      <Datum
        label="Proposed by"
        value={
          r.bonded ? (
            <ShieldedAccount address={r.proposer ?? ''} />
          ) : (
            // Worth naming rather than hiding. A trader deciding whether to challenge should know
            // that this one carries no stake behind it.
            'The operator, without a stake'
          )
        }
      />
      {r.bonded && r.bond && <Datum label="Staked" value={formatUsd(amount(r.bond), 6)} />}
      {r.phase === 'PROPOSED' && r.disputeDeadline && (
        <Datum
          label={r.disputable ? 'Open to challenge until' : 'Challenge window closed'}
          value={new Date(r.disputeDeadline).toLocaleString()}
        />
      )}
      {r.phase === 'DISPUTED' && (
        <>
          <Datum label="Disputed by" value={<ShieldedAccount address={r.disputer ?? ''} />} />
          <Datum label="Says the answer is" value={label(r.counterOutcome)} strong />
        </>
      )}
      {r.phase === 'SETTLED' && r.loser && (
        <Datum
          label="Forfeited"
          value={`${formatUsd(amount(r.forfeited), 6)}, and barred from trading`}
          tone="neg"
        />
      )}
    </dl>
  );
}

/** The terms, once we know they are available. Null while loading or when the resolver is absent. */
type Terms = Extract<ResolutionTerms, { available: true }> | null;

/**
 * Whether this market's shielded account can actually cover the stake.
 *
 * Asked before anything is signed, because the alternative is what used to happen: the account has
 * no collateral, the bond transfer reverts in simulation, and the proposer is told their proposal
 * "was not accepted" with a guess about somebody having got there first. The money answer is the
 * one the chain gives, and it is knowable up front for the price of one balance read.
 *
 * Fails open on purpose. An unreadable balance disables nothing, because a false negative here
 * blocks a proposal that would have worked, and the relayer simulates before it broadcasts anyway.
 */
function useStakeCheck(market: Market, terms: Terms, stake: bigint) {
  const account = useMarketAccountBalance({
    marketRef: market.id,
    token: market.collateral,
    // The resolver pulls the bond, so it is the resolver's allowance and balance that matter.
    spender: terms?.resolver ?? '',
    enabled: Boolean(terms?.resolver) && stake > 0n,
  });

  const known = !account.unset && !account.isPending && !account.isError;
  // `settledBalance`, not `balance`. A deposit still in flight is money the resolver cannot pull
  // yet, and staking against it produces exactly the confusing revert this check was written to
  // replace. The panel above shows the optimistic figure; this one decides.
  const settled = account.settledBalance;
  return {
    balance: settled,
    known,
    shortfall: known && stake > 0n && settled < stake ? stake - settled : null,
  };
}

/** Says what is missing and how much, rather than leaving it to a failed transaction. */
function Shortfall({ balance, needed }: { balance: bigint; needed: bigint }) {
  return (
    <p className="mt-3 border-l-2 border-accent-dim pl-2.5 text-[12px] leading-relaxed text-ink-dim">
      This market&rsquo;s account holds <span className="tabular">{formatUsd(balance, 6, { cents: true })}</span>,
      so it is <span className="tabular text-ink">{formatUsd(needed, 6, { cents: true })}</span> short
      of the stake. Top it up from the funding panel above, then come back.
    </p>
  );
}

/** Stake a bond on what the result was. */
function ProposeForm({
  market,
  terms,
  loading,
}: {
  market: Market;
  terms: Terms;
  loading: boolean;
}) {
  const [choice, setChoice] = React.useState<number | null | undefined>(undefined);
  const { propose, busy, available } = useResolutionActions({
    marketRef: market.id,
    engine: market.address,
    token: market.collateral,
  });
  const toast = useToast();
  const queryClient = useQueryClient();

  const stake = terms ? amount(terms.bond) + amount(terms.fee) : 0n;
  const { shortfall, balance } = useStakeCheck(market, terms, stake);

  async function submit() {
    if (choice === undefined || !terms) return;
    const result = await propose({
      marketId: BigInt(market.marketId),
      outcomeId: choice,
      stake,
    });
    if (result.ok) {
      toast.success(
        'Result proposed',
        'Your stake is locked until the challenge window closes. Nothing links it to you.',
      );
      await queryClient.invalidateQueries({ queryKey: ['market', market.id] });
    } else {
      // A pending submission is not a failure and must not be reported as one, or the proposer
      // stakes a second time on the same market.
      toast[result.pending ? 'info' : 'error'](
        result.pending ? 'Submitted, not yet settled' : 'Not proposed',
        result.message,
      );
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-[13px] text-ink-dim">
        Trading has closed and nobody has proposed a result yet. If you know it, you can say so.
      </p>

      <OutcomeChoice market={market} choice={choice} onChoose={setChoice} disabled={busy} />

      {terms && (
        <dl className="mt-3 space-y-2">
          <Datum label="Stake" value={formatUsd(amount(terms.bond), 6)} />
          <Datum label="Fee" value={formatUsd(amount(terms.fee), 6)} />
          <Datum
            label="Paid if unchallenged"
            value={
              amount(terms.reward) > 0n
                ? formatUsd(amount(terms.reward), 6)
                : 'Nothing yet, because this market has earned no fees'
            }
            tone={amount(terms.reward) > 0n ? 'pos' : undefined}
          />
          <Datum label="Challenge window" value={humanWindow(terms.disputeWindowSeconds)} />
        </dl>
      )}

      {shortfall !== null && <Shortfall balance={balance} needed={shortfall} />}

      {/*
        A relayed proposal is proved, signed and relayed exactly like a bet, and takes exactly as
        long. Without this the panel sat on a disabled button reading "Proposing…" for half a
        minute, which is the same complaint the trade ticket had before it drew the loop.
      */}
      {busy ? (
        <div className="mt-3 border border-accent-dim bg-accent-wash p-3.5">
          <Waiting label={`Proposing ${choice === null ? 'to void this market' : 'the result'}`} />
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          className="mt-3 w-full"
          disabled={loading || !terms || choice === undefined || shortfall !== null}
          onClick={() => void submit()}
        >
          {!available
            ? 'Unlock to propose a result'
            : choice === undefined
              ? 'Choose a result first'
              : shortfall !== null
                ? `Add ${formatUsd(shortfall, 6, { cents: true })} to propose`
                : `Propose and stake ${terms ? formatUsd(stake, 6) : ''}`}
        </Button>
      )}

      <p className="mt-2 text-[12px] text-ink-mute">
        You get the stake back unless the quorum finds the result you named was false.
      </p>
    </div>
  );
}

/** Stake an equal bond that the standing proposal is wrong. */
function DisputeForm({
  market,
  terms,
  label,
}: {
  market: Market;
  terms: Terms;
  label: (index: number | null) => string;
}) {
  const [choice, setChoice] = React.useState<number | null | undefined>(undefined);
  const { dispute, busy, available } = useResolutionActions({
    marketRef: market.id,
    engine: market.address,
    token: market.collateral,
  });
  const toast = useToast();
  const queryClient = useQueryClient();

  const r = market.resolution;
  const proposed = r?.proposedOutcome ?? null;
  // Matched against what the proposer staked, so neither side can be outspent. A bond-free operator
  // proposal has nothing to match, so it falls back to the live figure.
  const bond = r?.bonded && r.bond && amount(r.bond) > 0n ? amount(r.bond) : amount(terms?.bond);
  const stake = bond + amount(terms?.fee);
  const { shortfall, balance } = useStakeCheck(market, terms, stake);

  async function submit() {
    if (choice === undefined || !terms) return;
    const result = await dispute({
      marketId: BigInt(market.marketId),
      counterOutcomeId: choice,
      stake,
    });
    if (result.ok) {
      toast.success('Dispute raised', 'The operator quorum will decide this market.');
      await queryClient.invalidateQueries({ queryKey: ['market', market.id] });
    } else {
      toast[result.pending ? 'info' : 'error'](
        result.pending ? 'Submitted, not yet settled' : 'Not disputed',
        result.message,
      );
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-[13px] text-ink-dim">
        If <span className="text-ink">{label(proposed)}</span> is wrong, stake the same amount
        against it and the quorum will decide.
      </p>

      <OutcomeChoice
        market={market}
        choice={choice}
        onChoose={setChoice}
        disabled={busy}
        exclude={proposed}
      />

      {terms && (
        <dl className="mt-3 space-y-2">
          <Datum label="Stake" value={formatUsd(bond, 6)} />
          <Datum label="Fee" value={formatUsd(amount(terms.fee), 6)} />
        </dl>
      )}

      {shortfall !== null && <Shortfall balance={balance} needed={shortfall} />}

      {busy ? (
        <div className="mt-3 border border-accent-dim bg-accent-wash p-3.5">
          <Waiting label="Staking your dispute" />
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          className="mt-3 w-full"
          disabled={!terms || choice === undefined || shortfall !== null}
          onClick={() => void submit()}
        >
          {!available
            ? 'Unlock to dispute'
            : choice === undefined
              ? 'Choose what the answer is'
              : shortfall !== null
                ? `Add ${formatUsd(shortfall, 6, { cents: true })} to dispute`
                : `Dispute and stake ${terms ? formatUsd(stake, 6) : ''}`}
        </Button>
      )}

      <p className="mt-2 text-[12px] text-ink-mute">
        You lose the stake, and the right to trade here, if the quorum upholds the proposal.
      </p>
    </div>
  );
}

/**
 * Pick an outcome, or void.
 *
 * `undefined` means nothing chosen and `null` means "void this market", and the two must stay
 * distinct: outcome 0 is falsy, so a truthiness check here would silently turn the first outcome
 * into "nothing selected" and the submit button would never enable.
 */
function OutcomeChoice({
  market,
  choice,
  onChoose,
  disabled,
  exclude,
}: {
  market: Market;
  choice: number | null | undefined;
  onChoose: (v: number | null) => void;
  disabled?: boolean;
  exclude?: number | null;
}) {
  const options: Array<{ value: number | null; label: string }> = [
    ...market.outcomes
      .filter((o) => o.index !== exclude)
      .map((o) => ({ value: o.index, label: o.label || `Outcome ${o.index + 1}` })),
  ];
  if (exclude !== null) options.push({ value: null, label: 'Void' });

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.value === null ? 'void' : o.value}
            variant={choice === o.value ? 'primary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={() => onChoose(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {/*
        Shown only once void is the standing choice, and it has to be shown then.

        Void appears here and nowhere else in the product, which is correct — it is a settlement
        answer, not an outcome, and the engine makes that structural: `_tradable` rejects any
        outcomeId at or above `outcomeCount`, so the sentinel can never be bought or sold. But a
        button that is not one of the market's outcomes, sitting next to a bond the size of a real
        bet, needs to say what it does.

        The last sentence is the one that matters most: void reads like an escape hatch and is not
        one. It costs exactly as much to get wrong as naming the wrong winner does.
      */}
      {choice === null && (
        <p className="mt-2.5 border-l-2 border-accent-dim pl-2.5 text-[11.5px] leading-relaxed text-ink-dim">
          Voiding refunds everybody instead of paying a winner, and returns what each trader put in
          rather than splitting the pot evenly. It is for a question that cannot be settled honestly,
          because the event did not happen as described or the result matches none of the outcomes
          listed. It stakes the same bond as any other claim, so if the market turns out to have been
          answerable, you lose it.
        </p>
      )}
    </div>
  );
}

function humanWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}
