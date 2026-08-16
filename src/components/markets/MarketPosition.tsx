'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { formatAmount, formatSignedUsd, formatUsd, toBigInt } from '@/lib/format';
import { useVisibleHoldings } from '@/lib/optimistic/useVisibleHoldings';
import { predictClaim } from '@/lib/optimistic/predict';
import { useHasMarketAccount } from '@/lib/execution/useMarketAccount';
import { useClaimPosition } from '@/lib/trade/useClaimPosition';
import type { Market, Position } from '@/lib/api/types';
import { Button } from '@/components/ui/Button';
import { Datum, Folio } from '@/components/ui/primitives';
import { Explain } from '@/components/ui/Explain';
import { ShieldedAccount } from '@/components/ui/Shielded';
import { useToast } from '@/components/ui/Toast';
import { outcomeVar } from './Outcomes';

/**
 * What this market owes the user, on the market's own page.
 *
 * Placing a bet used to leave the trader on a screen that showed no trace of it — the position
 * lived on a separate portfolio screen, and the private balance had already gone down by the
 * stake. From where they were standing that is indistinguishable from money disappearing, so the
 * answer belongs here, next to the ticket that took it.
 *
 * This is now the *only* place a position appears. There is no cross-market portfolio: a screen
 * that gathers every bet a person has made into one list is the one view this product should not
 * build, however well the addresses behind it are shielded.
 *
 * Which makes settlement this panel's job too. Claiming used to live on that other screen, and it
 * is the step that turns a won bet into money — so it moved here rather than away.
 *
 * The addresses are derived in the browser and the query asks only for public on-chain figures.
 * The server cannot derive any of it from the login; that link does not exist.
 */
export function MarketPosition({ market }: { market: Market }) {
  const bound = useHasMarketAccount(market.id, market.collateral, market.address);
  // The display view, which includes a bet that has landed on chain and is waiting on our indexer.
  // The ticket above sizes sales from the confirmed one; see `lib/optimistic/useVisibleHoldings`.
  const { positions: mine, pending } = useVisibleHoldings(market);

  // Nothing here and nothing on the way: stay out of the way entirely rather than render an
  // empty panel on every market the user has never touched.
  if (mine.length === 0 && !bound) return null;

  const decimals = market.collateralDecimals;
  const totals = mine.reduce(
    (acc, p) => ({
      value: acc.value + (toBigInt(p.markToMarket) ?? 0n),
      basis: acc.basis + (toBigInt(p.costBasis) ?? 0n),
    }),
    { value: 0n, basis: 0n },
  );
  const pnl = totals.value - totals.basis;

  return (
    <section className="plate p-4 sm:p-5">
      <Explain
        label="How a position is held"
        // Named while any figure on screen is ahead of the server. Not a spinner: nothing is
        // blocked and nothing needs waiting for, the number is simply younger than the record.
        right={<Folio>{pending ? 'Settling' : `${mine.length || ''} held`}</Folio>}
        detail={
          <>
            <p>
              These shares are held by a shielded account, not by your login — the link between
              the two does not exist anywhere on our servers.
            </p>
            <p className="text-ink-mute">
              A NO position is one share of every other outcome, so it shows as several lines.
              Together they pay 1 per share whenever the outcome you sold loses.
            </p>
          </>
        }
      >
        Your position
      </Explain>

      {mine.length === 0 ? (
        <p className="mt-4 text-[12px] text-ink-mute">Indexing your bet — a few seconds.</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {mine.map((p) => (
              <PositionLine key={`${p.account}-${p.outcomeIndex}`} position={p} decimals={decimals} />
            ))}
          </ul>

          <dl className="mt-4 space-y-2.5">
            <Datum label="Cost basis" value={formatUsd(totals.basis, decimals)} />
            <Datum label="Value now" value={formatUsd(totals.value, decimals)} strong />
            <Datum
              label="Unrealised P&L"
              value={formatSignedUsd(pnl, decimals)}
              tone={pnl > 0n ? 'pos' : pnl < 0n ? 'neg' : undefined}
            />
          </dl>
        </>
      )}
    </section>
  );
}

/**
 * Whether this line is money waiting to be collected.
 *
 * A won outcome on a resolved market, or anything at all on an invalid one — an invalid market
 * refunds every side. Already redeemed means the payout has happened and there is nothing left.
 */
function isClaimable(position: Position): boolean {
  if (position.redeemed) return false;
  if (position.marketStatus === 'INVALID') return true;
  return position.marketStatus === 'RESOLVED' && position.winningOutcomeId === position.outcomeIndex;
}

function PositionLine({ position, decimals }: { position: Position; decimals: number }) {
  const value = toBigInt(position.markToMarket);
  const basis = toBigInt(position.costBasis);
  const delta = value !== null && basis !== null ? value - basis : null;

  return (
    <li className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-1.75 shrink-0"
            style={{ background: outcomeVar(position.outcomeIndex) }}
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-ink">
              {position.outcomeLabel || `Outcome ${position.outcomeIndex + 1}`}
            </span>
            {/* The account is the point of the product, not a debugging detail: this is the
                on-chain holder, and it is not linked to the user's login anywhere. */}
            <ShieldedAccount address={position.account} showGlyph={false} />
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="tabular block text-[13px] text-ink">
            {formatAmount(position.shares, decimals)} shares
          </span>
          <span
            className={cn(
              'tabular block text-[11.5px]',
              delta === null
                ? 'text-ink-mute'
                : delta > 0n
                  ? 'text-pos'
                  : delta < 0n
                    ? 'text-neg'
                    : 'text-ink-dim',
            )}
          >
            {formatUsd(value, decimals)}
            {delta !== null && delta !== 0n ? ` · ${formatSignedUsd(delta, decimals)}` : ''}
          </span>
        </span>
      </div>

      {isClaimable(position) ? (
        <ClaimAction position={position} />
      ) : position.redeemed ? (
        <p className="folio mt-2">Collected</p>
      ) : null}
    </li>
  );
}

/**
 * Collecting a settled position.
 *
 * Full width and directly under the line it settles, rather than a small button in the row: this
 * is the last step of the whole product, it appears on perhaps one line in the panel's lifetime,
 * and a trader who cannot find it has simply lost the bet they won.
 */
function ClaimAction({ position }: { position: Position }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { claim, needsUnlock, unavailable, unlock } = useClaimPosition();
  const [claiming, setClaiming] = React.useState(false);

  async function collect() {
    if (needsUnlock) {
      await unlock();
      return;
    }
    setClaiming(true);
    // Flip the line now. The shares stay: `redeem` marks a position paid, it does not delete it,
    // and predicting a disappearance would be undone at the next poll.
    const revert = predictClaim({
      account: position.account,
      marketRef: position.marketRef,
      outcomeIndex: position.outcomeIndex,
      shares: toBigInt(position.shares) ?? 0n,
    });
    try {
      const result = await claim(position);
      if (!result.ok) {
        // A pending claim may still land, so its prediction stands. Anything else is put back
        // before the toast, so the line and the sentence explaining it agree.
        if (result.reason !== 'pending') revert();
        // An outage is not a failed claim: the position is untouched and will still pay out.
        // Saying "not collected" under the same title as a rejected claim invites the user to go
        // looking for a problem with a position that does not have one.
        toast.error(
          result.reason === 'unavailable'
            ? 'Private trading unavailable'
            : 'Your winnings were not collected',
          `${result.message ?? 'The claim could not be submitted.'} This position is still yours to collect.`,
        );
        return;
      }
      // Claiming moves money, so say so. Without this the only feedback is a line quietly
      // changing to "Collected", which is easy to miss and reads as nothing having happened.
      toast.success(
        'Winnings collected',
        `${position.outcomeLabel || `Outcome ${position.outcomeIndex + 1}`} — paid into your private balance.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="mt-2.5">
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        // Only truly blocked when there is no privacy layer to claim through. Needing an unlock
        // is a step, not a refusal, so the button stays live and performs it.
        disabled={unavailable || claiming}
        onClick={() => void collect()}
      >
        {claiming ? 'Collecting…' : needsUnlock ? 'Unlock to collect' : 'Collect winnings'}
      </Button>
    </div>
  );
}
