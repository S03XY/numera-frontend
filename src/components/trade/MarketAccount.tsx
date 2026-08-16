'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { formatUnits, formatUsd, parseDecimalAmount } from '@/lib/format';
import type { Market } from '@/lib/api/types';
import { useSession, type SessionStatus } from '@/lib/auth/useSession';
import { usePool } from '@/lib/pool/PoolProvider';
import { useShieldedPool } from '@/lib/pool/useShieldedPool';
import { useMarketAccountBalance } from '@/lib/execution/useMarketAccount';
import { predictTransfer } from '@/lib/optimistic/predict';
import { useMarketFunding } from '@/lib/trade/useMarketFunding';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { LiveBalance } from '@/components/ui/LiveBalance';
import { Explain } from '@/components/ui/Explain';
import { ShieldedAccount } from '@/components/ui/Shielded';
import { CopyButton } from '@/components/ui/CopyButton';
import { settlingInterval, useSettlingBalance } from '@/lib/pool/useSettlingBalance';
import { SETTLE_BEAT, ShieldingProgress } from './ShieldingProgress';

/**
 * Topping up the market's own shielded account, and emptying it again.
 *
 * ## Why this step exists at all
 *
 * Numera gives every (user, market) pair its own execution account, and that account — not the
 * user — is what the contracts see. Collateral therefore has to make one trip: out of the shielded
 * pool and into the account, before any bet on this market can be placed.
 *
 * That trip used to be invisible, folded into whichever trade first needed it. Three things went
 * wrong with that. It made the first bet on a market roughly seven times the gas of every later
 * one with no explanation. It made the most fragile operation in the system present as part of
 * the bet, so when the pool withdrawal failed the trader was told their *bet* had been rejected.
 * And it left change sitting in the account afterwards with nothing on screen accounting for it.
 *
 * ## Why the explanation is behind a disclosure
 *
 * All of the above is true and none of it is needed twice. The resting panel is two figures, a
 * field and a button; everything that explains the model — what the account is, which address
 * holds it, why the return trip is unavailable — sits behind the ⓘ. A trader who wants it presses
 * once; a trader who has already understood it never sees it again, which is the only way a panel
 * this close to the money stays readable.
 */

/** Whole collateral units offered as one-tap top-ups. */
const QUICK_DEPOSIT = [10, 25, 50] as const;

type Busy = 'deposit' | 'withdraw' | null;

export interface MarketAccountProps {
  market: Market;
  /** Controlled deposit amount, so the ticket can ask for a specific shortfall. */
  amount: string;
  onAmountChange: (value: string) => void;
  /**
   * A trade is in flight on this market's account, so no transfer may start.
   *
   * One shielded account runs one operation at a time; see `TradePanel`.
   */
  blocked?: boolean;
  /** Reports a transfer starting and finishing, so the ticket can stand down. */
  onBusyChange?: (busy: boolean) => void;
}

export function MarketAccount({
  market,
  amount,
  onAmountChange,
  blocked = false,
  onBusyChange,
}: MarketAccountProps) {
  const { status: poolStatus } = usePool();
  const shielded = useShieldedPool();
  const { status: session } = useSession();
  const funding = useMarketFunding();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [busy, setBusy] = React.useState<Busy>(null);
  const [sessionStatus, setSessionStatus] = React.useState<string | null>(null);
  /** The transfer landed; hold the finished animation up for a beat before the panel returns. */
  const [settled, setSettled] = React.useState(false);

  const decimals = market.collateralDecimals;
  const ready = poolStatus === 'ready' && shielded !== null;

  const awaitingPoolRef = React.useRef<bigint | null>(null);

  const pool = useQuery({
    queryKey: ['pool', 'balance', market.collateral],
    queryFn: () => shielded!.balance(market.collateral),
    enabled: ready,
    // Engine under-reports while it catches up, so poll until it says it is current...
    refetchInterval: (query) => {
      if (query.state.data?.syncing) return 3_000;
      // ...and then until it reflects the transfer we just made, which `syncing` does not cover.
      // The market figure beside it self-corrects on its own twelve-second poll; this one had no
      // such floor, so a top-up could leave the private balance reading its pre-transfer value
      // indefinitely. Same fault as the Wallet deposit — see `useSettlingBalance`.
      return settlingInterval(awaitingPoolRef, query.state.data?.total);
    },
  });

  const settlingPool = useSettlingBalance(awaitingPoolRef, pool.data?.total);

  const account = useMarketAccountBalance({
    marketRef: market.id,
    token: market.collateral,
    spender: market.address,
    enabled: ready,
  });

  const parsed = parseDecimalAmount(amount, decimals);
  const spendable = pool.data?.spendable ?? 0n;
  /**
   * What the trader actually owns, including change still settling.
   *
   * A shielded pool spends whole notes and mints change, so a top-up of 10 out of 500 nullifies
   * the 500-note and creates a 490 change note that Engine will not count until it has resolved.
   * Showing `spendable` alone therefore made the private balance *drop by the whole note* after
   * every top-up and climb back minutes later — reported from the UI as "the balance was 489 and
   * somehow became 500". Nothing moved either time; the figure was under-reporting.
   *
   * So the headline is what they own and {@link shortOfSpendable} explains what is momentarily
   * out of reach. Spending is still gated on `spendable`, because that part is true.
   */
  const owned = pool.data?.total ?? 0n;
  const settling = pool.data?.pendingChange ?? 0n;
  /**
   * Only ever judged against a balance we have actually read.
   *
   * Before the first read resolves there is no balance, and treating that as zero told every
   * trader who typed a number in the first second that it was "more than your private balance of
   * $0" — and disabled the button that would have proved otherwise.
   */
  const overdrawn = pool.data !== undefined && parsed !== null && parsed > spendable;
  /** Within what they own, but not yet spendable — a wait, not a refusal. */
  const shortOfSpendable = overdrawn && parsed !== null && parsed <= owned;
  const stage = stageOf({
    ready,
    unavailable: funding.unavailable,
    needsUnlock: funding.needsUnlock,
    unset: account.unset,
    balance: account.balance,
  });

  React.useEffect(() => {
    onBusyChange?.(busy !== null);
  }, [busy, onBusyChange]);

  /** Everything the two transfers touch, refreshed together so the panel can never disagree. */
  function invalidateMoney() {
    void queryClient.invalidateQueries({ queryKey: ['unlink', 'balances'] });
    // `['execution', ...]`, which is where `useMarketAccountBalance` actually registers. This said
    // `['unlink', 'market-account']` and so matched nothing at all: after a top-up the market
    // figure was never refreshed and sat on its previous value — frequently zero, since the
    // transfer people notice most is their first — until the twelve-second poll came round.
    void queryClient.invalidateQueries({ queryKey: ['execution', 'market-account'] });
  }

  async function handleDeposit() {
    if (parsed === null || parsed <= 0n) return;
    setBusy('deposit');
    setSessionStatus(null);
    // Captured before the transfer: afterwards the cache may already hold the new figure, and a
    // value compared with itself waits forever.
    const poolBefore = pool.data?.total;
    // Move the market figure now. This one is read straight from the chain rather than through the
    // indexer, so it lags less than a position does — but money leaving the private balance and not
    // yet arriving here is the most alarming gap on the screen, and it is what makes somebody
    // deposit twice.
    const revert = predictTransfer({
      account: account.address,
      token: market.collateral,
      balance: account.settledBalance,
      delta: parsed,
    });
    try {
      const result = await funding.deposit({ market, amount: parsed, onStatus: setSessionStatus });
      if (!result.ok) {
        // A pending transfer may still land, so its prediction stands rather than snapping the
        // balance back under a message that says it might yet arrive.
        if (result.reason !== 'pending') revert();
        report(toast, result, 'deposit');
        return;
      }
      onAmountChange('');
      settlingPool.expect(poolBefore);
      invalidateMoney();
      // The animation finishes before the panel comes back. Cutting it off mid-scramble reads as
      // the transfer having been abandoned, which is the opposite of what just happened.
      setSettled(true);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BEAT));
      toast.success(
        'This market is funded',
        'Your bets here now spend from this balance. Nothing links the account to you.',
      );
    } finally {
      setBusy(null);
      setSettled(false);
      setSessionStatus(null);
    }
  }

  async function handleWithdraw() {
    // Settled: sweeping a balance that includes an unlanded deposit asks the pool for money the
    // account does not hold yet.
    if (account.settledBalance <= 0n) return;
    setBusy('withdraw');
    setSessionStatus(null);
    const poolBefore = pool.data?.total;
    try {
      // Re-read first. The sweep is capped at the figure it is given, and this balance is polled
      // every twelve seconds — so a sale settling between the last poll and this press would leave
      // the difference behind as dust, in an account the trader believes they just emptied.
      const fresh = await account.refetch();
      const balance = fresh ?? account.settledBalance;
      if (balance <= 0n) return;

      const revert = predictTransfer({
        account: account.address,
        token: market.collateral,
        balance,
        delta: -balance,
      });
      const result = await funding.withdraw({
        market,
        balance,
        onStatus: setSessionStatus,
      });
      if (!result.ok) {
        if (result.reason !== 'pending') revert();
        report(toast, result, 'withdrawal');
        return;
      }
      settlingPool.expect(poolBefore);
      invalidateMoney();
      setSettled(true);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BEAT));
      toast.success(
        'Back in your private balance',
        'This market’s account is empty and the collateral is shielded again.',
      );
    } finally {
      setBusy(null);
      setSettled(false);
      setSessionStatus(null);
    }
  }

  return (
    <section className="plate p-4 sm:p-5">
      <Explain
        label="What is a market account?"
        right={<StageBadge stage={stage} />}
        detail={<AccountExplainer account={account.address} />}
      >
        Top up this market
      </Explain>

      {/*
        The two ends of the transfer, on one line and in the direction it moves. Both tick and
        both decrypt: a figure that never visibly changes is one a trader stops trusting the
        moment they have moved money and the screen looks the same.
      */}
      {/*
        Wraps rather than overflows.

        Both halves are short at rest — "Market $12.00", "Private $488.00" — and neither stays
        short: the private figure grows a "$0.49 settling" note after every top-up, which is
        exactly the moment a trader is watching this row. At that width the pair is wider than a
        phone, and with nothing allowed to wrap the second half simply left the plate.
      */}
      <dl className="mt-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 border-y border-line py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <dt className="folio">Market</dt>
          <dd className="text-[15px] text-ink">
            {!ready ? (
              <span className="text-[12.5px] text-ink-mute">
                {poolStatus === 'unavailable' ? 'Unavailable' : 'Locked'}
              </span>
            ) : (
              <LiveBalance
                // `known`, not `!isError`: a read that has not answered yet is also not a zero,
                // and this figure decides whether a trade is affordable.
                value={account.unset || !account.known ? null : account.balance}
                decimals={decimals}
                pending={account.isPending}
                chars={6}
                placeholder={
                  <span className="text-[12.5px]">{account.unset ? 'Locked' : 'Unreadable'}</span>
                }
              />
            )}
          </dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <dt className="folio">Private</dt>
          <dd className="text-[15px] text-ink-dim">
            <LiveBalance
              value={ready && pool.data ? owned : null}
              decimals={decimals}
              pending={ready && pool.isPending}
              chars={6}
              suffix={
                pool.data?.syncing ? (
                  <span className="folio ml-1.5">syncing</span>
                ) : settlingPool.pending ? (
                  // The transfer landed and the index has not. Said out loud rather than left as
                  // an unchanged number under a success toast, which is the pair that reads as
                  // "it took my money and did nothing".
                  <span className="folio ml-1.5" title="Your transfer is landing">
                    updating
                  </span>
                ) : settling > 0n ? (
                  // Named rather than silently subtracted. This is the figure whose absence read
                  // as money going missing.
                  <span className="folio ml-1.5" title="Change from your last transfer, settling">
                    {formatUsd(settling, decimals)} settling
                  </span>
                ) : null
              }
            />
          </dd>
        </div>
      </dl>

      {busy !== null ? (
        <div className="mt-3.5">
          <ShieldingProgress
            done={settled}
            status={sessionStatus}
            action={busy === 'deposit' ? 'Topping up this market' : 'Returning to private balance'}
          />
        </div>
      ) : !ready ? (
        <Locked
          session={session}
          unavailable={funding.unavailable}
          needsUnlock={funding.needsUnlock}
          onUnlock={() => void funding.unlock()}
        />
      ) : (
        <div className="mt-3.5 space-y-2">
          {/* Field and action on one line: this is a single gesture, not a form. */}
          <div className="flex gap-2">
            <input
              id="fund-amount"
              aria-label="Amount to add"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              placeholder="0.00"
              className="field tabular min-w-0 flex-1"
            />
            <Button
              variant="primary"
              size="md"
              className="shrink-0"
              disabled={
                parsed === null || parsed <= 0n || overdrawn || blocked || pool.data === undefined
              }
              onClick={() => void handleDeposit()}
            >
              Add
            </Button>
          </div>

          <div className="flex items-center gap-px bg-line">
            {QUICK_DEPOSIT.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onAmountChange(String(n))}
                className="mono h-10 flex-1 bg-bg text-[10.5px] tracking-widest text-ink-mute transition-colors hover:text-ink sm:h-7"
              >
                ${n}
              </button>
            ))}
            <button
              type="button"
              disabled={spendable <= 0n}
              onClick={() => onAmountChange(formatUnits(spendable, decimals) ?? '')}
              className="mono h-10 flex-1 bg-bg text-[10.5px] tracking-widest text-ink-mute transition-colors hover:text-ink disabled:opacity-40 sm:h-7"
            >
              Max
            </button>
          </div>

          {/*
            Two different facts, and only one of them is the trader's fault. Asking for more than
            they own is a refusal; asking for more than has *settled* is a wait — and telling
            someone their balance is smaller than the figure directly above it, with no
            explanation, is how a working product loses trust.
          */}
          {overdrawn &&
            (shortOfSpendable ? (
              <p className="text-[11px] text-ink-mute">
                <span className="tabular">{formatUsd(spendable, decimals)}</span> of this is ready
                now — the rest is change from your last transfer and lands in a moment.
              </p>
            ) : (
              <p className="text-[11px] text-neg">
                More than your private balance of{' '}
                <span className="tabular">{formatUsd(owned, decimals)}</span>.
              </p>
            ))}

          {/*
            The way out, always visible once there is something to take out — a withdrawal the
            trader has to go looking for is one they assume does not exist. One press: it returns
            to the private balance it came from, with no address to type and nothing public in
            between.
          */}
          {account.balance > 0n && (
            <button
              type="button"
              disabled={blocked}
              onClick={() => void handleWithdraw()}
              // The only route back out of a funded market, so it gets a real target under a
              // thumb rather than a 14px line of small caps.
              className="folio block w-full py-2 text-left text-accent-bright transition-colors hover:text-ink disabled:opacity-40 sm:py-0 sm:pt-0.5"
            >
              &larr; Withdraw {formatUsd(account.balance, decimals)} to private balance
            </button>
          )}

          {blocked && (
            <p className="text-[11px] text-ink-mute">
              Finishing your bet first, so the two transfers cannot cross.
            </p>
          )}
        </div>
      )}
    </section>
  );
}


/**
 * Everything that explains the model, disclosed on request.
 *
 * The primer, the account address, and the provider caveat. None of them changes what a trader
 * does next, and all of them used to sit permanently in a panel whose resting job is "type a
 * number, press Add".
 */
function AccountExplainer({ account }: { account: string | null }) {
  return (
    <>
      <p>
        Bets on this market are placed by a shielded account that belongs to this market alone —
        that account, not you, is what the contracts see. It has to hold collateral before it can
        place a bet, so topping it up is the first step. Every bet after that is instant and costs
        a fraction of the first.
      </p>
      <p className="text-ink-mute">
        The account is derived from your key and is not linked to your login, your wallet, or any
        other market you trade. Anything you do not spend stays here until you withdraw it.
      </p>
      {account && (
        <p className="flex items-center gap-2">
          <span className="folio">Held by</span>
          <ShieldedAccount address={account} />
          {/*
            Copyable, because this address is the one thing here a trader ever needs outside the
            app: it is what they paste into the explorer to check their own position on chain, and
            what they would send us if a bet went wrong. `ShieldedAccount` renders it truncated —
            the full value only exists in the DOM as screen-reader text — so without this there is
            no way to get at it at all.
          */}
          <CopyButton value={account} label="market account address" />
        </p>
      )}
      <p className="text-ink-mute">
        Withdrawing returns the balance to the private balance it came from, in one transaction,
        settled through the pool itself — so nothing about it is visible as yours.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------- stages

type Stage = 'blocked' | 'locked' | 'empty' | 'ready';

function stageOf(s: {
  ready: boolean;
  unavailable: boolean;
  needsUnlock: boolean;
  unset: boolean;
  balance: bigint;
}): Stage {
  if (s.unavailable) return 'blocked';
  // `unset` now means only "no address to derive", which is the locked session — there is no
  // separate "set this market up" step left: the address exists the moment the session unlocks,
  // so the only question is whether it has been funded.
  if (!s.ready || s.needsUnlock || s.unset) return 'locked';
  return s.balance > 0n ? 'ready' : 'empty';
}

const STAGE_LABEL: Record<Stage, string> = {
  blocked: 'Unavailable',
  locked: 'Locked',
  empty: 'Needs funds',
  ready: 'Ready to trade',
};

/**
 * "Step 1 of 2" rather than "Empty" on the first stage: it is the only label that tells a
 * first-time trader there is a second step and that they are not stuck.
 */
function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span
      className={cn(
        'folio',
        stage === 'ready' && '!text-pos',
        stage === 'empty' && '!text-accent-bright',
        stage === 'blocked' && '!text-neg',
      )}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

function Locked({
  session,
  unavailable,
  needsUnlock,
  onUnlock,
}: {
  session: SessionStatus;
  unavailable: boolean;
  needsUnlock: boolean;
  onUnlock: () => void;
}) {
  if (unavailable) {
    return (
      <p
        role="note"
        className="mt-3.5 border border-line px-3 py-2.5 text-[11px] leading-relaxed text-ink-mute"
      >
        This deployment has no privacy layer configured, so market accounts cannot be funded.
      </p>
    );
  }
  if (!needsUnlock) return null;
  /*
    Signed out, so there is nothing yet to unlock.

    The privacy layer reports `locked` to a visitor and to a signed-in trader alike — it has no
    view of the session — so this panel offered the same live "Unlock private trading" button to
    somebody with no account at all. Pressing it opened a wallet prompt for a key the page could
    not name, and the failure that came back described a signature rather than the missing step.
    The market account is derived from the key they sign in with, so signing in genuinely is the
    first move, and the button says that instead while staying dead.

    `loading` shows nothing: a session restored from a refresh token lands one request later, and
    a button whose label flips from "Sign in" to "Unlock" mid-read is a worse first impression
    than one that arrives whole.
  */
  if (session === 'loading') return null;
  if (session !== 'authenticated') {
    return (
      <div className="mt-3.5 space-y-2">
        <Button variant="primary" size="md" className="w-full" disabled>
          Sign in to add funds
        </Button>
        <p className="text-[11px] leading-relaxed text-ink-mute">
          This market&rsquo;s account is derived from the key you sign in with. Press Enter at the
          top of the page to use a passkey or MetaMask.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3.5 space-y-2">
      <Button variant="primary" size="md" className="w-full" onClick={onUnlock}>
        Unlock private trading
      </Button>
      <p className="text-[11px] leading-relaxed text-ink-mute">
        One passkey touch per session, before any money moves.
      </p>
    </div>
  );
}

/** One place that decides how a transfer failure is announced. */
function report(
  toast: ReturnType<typeof useToast>,
  result: Extract<
    Awaited<ReturnType<ReturnType<typeof useMarketFunding>['deposit']>>,
    { ok: false }
  >,
  noun: 'deposit' | 'withdrawal',
) {
  const fallback = `The ${noun} could not be completed.`;
  // The balance moved on the press, so anything that did not go through has to say the figure was
  // put back — otherwise the error is read against a panel that still shows the transfer.
  const undone = 'The balance shown has been put back.';
  switch (result.reason) {
    // Submitted and undecided. Saying "nothing moved" here would invite a second transfer, and the
    // prediction is deliberately left standing for the same reason.
    case 'pending':
      return toast.info('Still settling', result.message ?? fallback);
    case 'unavailable':
      return toast.error(
        'Transfers are temporarily unavailable',
        `${result.message ?? fallback} ${undone}`,
      );
    case 'locked':
      return toast.error(
        'Unlock private trading first',
        'Your shielded accounts are derived from a key this session has not unlocked yet.',
      );
    default:
      return toast.error(
        noun === 'deposit' ? 'Top-up did not complete' : 'Withdrawal did not complete',
        `${result.message ?? fallback} ${undone}`,
      );
  }
}
