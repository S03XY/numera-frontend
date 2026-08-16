'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/Feedback';
import { Bar, Waiting, useDelayedFlag } from '@/components/ui/Waiting';
import { Datum, Folio, Plate, Rule, SectionHead } from '@/components/ui/primitives';
import { Explain } from '@/components/ui/Explain';
import { PrivacyMark } from '@/components/ui/Shielded';
import { CopyButton } from '@/components/ui/CopyButton';
import { formatMon, formatUsd } from '@/lib/format';
import { usePool } from '@/lib/pool/PoolProvider';
import { COLLATERAL_ADDRESS, COLLATERAL_DECIMALS, MONAD_FAUCET_URL } from '@/lib/chain/collateral';
import {
  claimTestTokens,
  faucetCooldown,
  formatDuration,
  nativeBalance,
  publicBalance,
} from '@/lib/wallet/collateral';
import { useShieldedPool } from '@/lib/pool/useShieldedPool';
import type { ShieldedPool } from '@/lib/execution/pool';
import { useSession } from '@/lib/auth/useSession';
import { signerWalletClient } from '@/lib/chain/evm';
import { reconnectWallet } from '@/lib/wallet/reconnect';
import { settlingInterval, useSettlingBalance } from '@/lib/pool/useSettlingBalance';

/** Parse a human amount ("12.50") into base units, or null if it is not a number. */
export function parseAmount(input: string, decimals = COLLATERAL_DECIMALS): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole, fraction = ''] = trimmed.split('.');
  // Reject rather than silently truncate: dropping a digit is a money bug.
  if (fraction.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

type Busy = 'faucet' | 'deposit' | 'withdraw' | 'restore' | 'recover' | null;

/** What failed, in the user's terms rather than the function's name. */
const LABELS: Record<Exclude<Busy, null>, string> = {
  faucet: 'Could not claim test collateral',
  deposit: 'Deposit did not complete',
  withdraw: 'Withdrawal did not complete',
  restore: 'Could not restore your positions',
  recover: 'Could not return your unswept funds',
};

export function Wallet() {
  const { status, reason, unlock } = usePool();
  const shielded = useShieldedPool();
  const { status: session } = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState<Busy>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const toast = useToast();

  const ready = status === 'ready' && shielded !== null;

  const awaitingTotalRef = React.useRef<bigint | null>(null);

  const balances = useQuery({
    queryKey: ['pool', 'balance', COLLATERAL_ADDRESS],
    queryFn: () => shielded!.balance(COLLATERAL_ADDRESS),
    enabled: ready && Boolean(COLLATERAL_ADDRESS),
    refetchInterval: (query) => {
      // Engine fails closed while it catches up, so a mid-sync figure is an UNDER-estimate and can
      // even read zero on a healthy account. Keep asking until it says it is current.
      if (query.state.data?.syncing) return 3_000;
      // ...and then keep asking until it reflects the transfer we just made. `syncing` alone does
      // not cover that, which is how a completed deposit left a stale figure on screen. See
      // `useSettlingBalance`.
      return settlingInterval(awaitingTotalRef, query.state.data?.total);
    },
  });

  const settling = useSettlingBalance(awaitingTotalRef, balances.data?.total);

  // Held back briefly so a fast read does not flash a placeholder for one frame.
  const showBalanceLoading = useDelayedFlag(balances.isPending);

  /**
   * Value the pool has taken but not delivered, so the balance above can be explained.
   *
   * Read separately from the balance because it answers a different question — not "what do you
   * have" but "why is that less than you expected" — and because a failure here must never stop
   * the balance rendering.
   */
  const held = useQuery({
    queryKey: ['pool', 'held', COLLATERAL_ADDRESS],
    queryFn: () => shielded!.held(COLLATERAL_ADDRESS),
    enabled: ready && Boolean(COLLATERAL_ADDRESS),
    retry: false,
  });

  async function run(kind: Exclude<Busy, null>, action: () => Promise<string | null>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    // Read before the action, not after: this is the figure the transfer is about to invalidate,
    // and comparing against a post-action read would compare it with itself.
    const before = balances.data?.total;
    try {
      const message = await action();
      setNotice(message);
      if (message) toast.success(message);
      // Only the two that move the shielded balance. The faucet moves the PUBLIC one, and waiting
      // for a figure that was never going to change is a spinner that always times out.
      if (kind === 'deposit' || kind === 'withdraw') settling.expect(before);
      await queryClient.invalidateQueries({ queryKey: ['unlink', 'balances'] });
      await queryClient.invalidateQueries({ queryKey: ['public'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError(message);
      // Deposits and withdrawals are money movements — the reason has to be
      // somewhere the user will actually see it, not only beside the button.
      toast.error(LABELS[kind], message);
    } finally {
      setBusy(null);
    }
  }

  if (status === 'unavailable') {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title="Private trading is not available here"
          description={reason ?? 'This deployment has no privacy layer configured.'}
        />
      </div>
    );
  }

  /*
    Nobody is signed in.

    There is no wallet here that is not somebody's: the balance, the address and every deposit are
    derived from the key of the signed-in account. Offering "Unlock private trading" to a visitor
    who holds no key sends them into a wallet prompt that cannot succeed, and says nothing about
    the step they actually missed.

    The masthead no longer links here while anonymous, so this is the bookmark and shared-link
    path rather than the common one — but it is exactly the path where a dead end is least
    expected. `loading` renders the heading alone: a session restored from a refresh token arrives
    one request later, and telling a signed-in user to sign in for that beat is its own small lie.
  */
  if (session !== 'authenticated') {
    return (
      <div className="space-y-6">
        <Header />
        {session === 'loading' ? null : (
          <EmptyState
            title="Sign in to open your wallet"
            description="Your shielded balance belongs to the key you sign in with, so there is nothing to show until you do. Press Enter at the top of the page and use a passkey or MetaMask."
          />
        )}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="space-y-6">
        <Header />
        <Plate className="space-y-4 p-4 sm:p-6">
          <p className="text-[14px] text-ink-dim">
            One signature per session. The key never leaves this device.
          </p>
          {status === 'error' && reason ? (
            <p className="text-[13px] text-neg">{reason}</p>
          ) : null}
          <Button
            variant="primary"
            onClick={() => void unlock()}
            disabled={status === 'unlocking'}
          >
            {status === 'unlocking' ? 'Unlocking…' : 'Unlock private trading'}
          </Button>
        </Plate>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <Header />

      <section className="space-y-4">
        <SectionHead>Shielded balance</SectionHead>
        <Plate className="space-y-3 p-4 sm:p-6">
          {balances.isPending ? (
            <p
              className="tabular text-[28px] leading-none sm:text-[34px]"
              role="status"
              aria-label="Reading balance"
            >
              {showBalanceLoading ? <Bar chars={9} /> : <span>&nbsp;</span>}
            </p>
          ) : (
            <p className="tabular text-[28px] leading-none text-ink sm:text-[34px]">
              {formatUsd((balances.data?.total ?? 0n).toString(), COLLATERAL_DECIMALS)}
            </p>
          )}

          {/*
            Engine fails closed while it catches up, so a mid-sync figure is an
            UNDER-estimate — it can even read zero on a healthy account. Showing
            it bare is how a routine trade looks like a disappearance, so the
            number is labelled rather than presented as final.
          */}
          {balances.data?.syncing ? (
            <p role="status" className="text-[12px] leading-relaxed text-accent-bright">
              Still settling your last transaction — this figure is temporarily low and will
              correct itself in a moment. Nothing is lost.
            </p>
          ) : settling.pending ? (
            // The transfer completed and the index has not caught up. Said out loud, because the
            // alternative is a success toast over a number that did not move — which is the exact
            // pair that reads as "it took my money and did nothing".
            <p role="status" className="text-[12px] leading-relaxed text-accent-bright">
              Your transfer went through and this figure is catching up — it updates here by
              itself, usually within a few seconds.
            </p>
          ) : null}

          {!balances.data?.syncing && (balances.data?.pendingChange ?? 0n) > 0n ? (
            <p className="text-[12px] leading-relaxed text-ink-mute">
              {formatUsd((balances.data?.spendable ?? 0n).toString(), COLLATERAL_DECIMALS)} is
              available to trade now; the rest is change from a recent trade and lands shortly.
            </p>
          ) : null}

          {/*
            The figure this balance has been silently short by. A withdrawal Engine accepts but
            never finishes holds its input notes forever — the tokens are still in the pool and
            nothing is spent, but `spendable` drops by the whole amount with nothing on screen
            accounting for it. Enough of them and the balance reads zero, which is how a working
            wallet convinces someone they have been robbed.
          */}
          {held.data && held.data.total > 0n ? (
            <div role="note" className="space-y-1.5 border border-neg/40 px-3 py-2.5">
              <p className="text-[12px] leading-relaxed text-ink-dim">
                <span className="tabular text-neg">
                  {formatUsd(held.data.total.toString(), COLLATERAL_DECIMALS)}
                </span>{' '}
                is held by {held.data.operations.length} operation
                {held.data.operations.length === 1 ? '' : 's'} that never finished, so it is missing
                from the figure above. It is still in the pool and still yours — the privacy
                provider has to release it, and we have reported this to them.
              </p>
              <ul className="space-y-0.5">
                {held.data.operations.map((op) => (
                  <li key={op.txId} className="mono text-[10.5px] text-ink-mute">
                    {formatUsd(op.amount.toString(), COLLATERAL_DECIMALS)} · {op.txId.slice(0, 8)}…
                    · since {op.since.slice(0, 16).replace('T', ' ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Folio>Held privately · not visible on-chain</Folio>
          <Rule />
          {/*
            There is deliberately no "shielded address" here.

            The previous privacy layer gave every user one, and showing it was honest under that
            design. This pool does not: a balance is a set of commitments nobody can attribute, and
            there is no per-user handle to display — which is the stronger property, so inventing
            something to put in its place would misrepresent it.
          */}
          <p className="text-[12.5px] text-ink-mute">
            Your balance is held as notes in a shared pool. Nothing on chain links them to you, and
            they are recovered from your passkey alone — there is nothing here to back up or lose.
          </p>
        </Plate>
      </section>

      {notice ? <p className="text-[13px] text-accent-bright">{notice}</p> : null}
      {error ? <p className="text-[13px] text-neg">{error}</p> : null}

      <PublicAccountPanel />
      <FundingPanel busy={busy} run={run} pool={shielded} />
      <WithdrawPanel busy={busy} run={run} pool={shielded} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="h-sec">Wallet</h1>
      <p className="mt-2.5 flex items-center gap-2 text-[14px] text-ink-dim">
        <PrivacyMark />
        Funds inside the pool cannot be traced to you.
      </p>
    </header>
  );
}

/**
 * The public side of the account.
 *
 * Deliberately shown, despite this being a privacy product. Entering a shielded
 * pool is inherently public — value has to come from somewhere — and gas on
 * Monad is paid in MON, which a brand-new passkey account has none of. Without
 * this panel a first-time tester sees "Get test collateral", presses it, and
 * gets an insufficient-funds error naming an address the UI never showed them.
 *
 * Everything *after* the deposit is unlinkable; this is the one screen where
 * the public address legitimately belongs.
 */
function PublicAccountPanel() {
  const { user } = useSession();
  const address = user?.address ?? null;

  const gas = useQuery({
    queryKey: ['public', 'native', address],
    queryFn: () => nativeBalance(address!),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });

  const collateral = useQuery({
    queryKey: ['public', 'collateral', address],
    queryFn: () => publicBalance(COLLATERAL_ADDRESS, address!),
    enabled: Boolean(address) && Boolean(COLLATERAL_ADDRESS),
    refetchInterval: 30_000,
  });

  if (!address) return null;

  const needsGas = gas.data !== undefined && gas.data === 0n;

  return (
    <section className="space-y-4">
      <Explain
        label="What the public account is for"
        detail={
          <p>
            The address you signed in with. It pays gas for the two public steps — claiming test
            collateral and depositing — and nothing after that is linked to it.
          </p>
        }
      >
        Your public account
      </Explain>
      <Plate className="space-y-4 p-4 sm:p-6">
        <dl className="space-y-2">
          <Datum
            label="Address"
            value={
              <span className="flex items-center gap-2">
                <span className="mono break-all">{address}</span>
                <CopyButton value={address} label="public address" />
              </span>
            }
          />
          <Datum
            label="Gas (MON)"
            value={gas.isPending ? '—' : formatMon(gas.data ?? 0n)}
            tone={needsGas ? undefined : 'accent'}
          />
          <Datum
            label="Collateral held publicly"
            value={
              collateral.isPending
                ? '—'
                : formatUsd((collateral.data ?? 0n).toString(), COLLATERAL_DECIMALS)
            }
          />
        </dl>

        {needsGas && (
          <div className="space-y-2 border border-line p-3">
            <p className="text-[12px] leading-relaxed text-ink">
              This account holds no MON, so it cannot send a transaction yet. Claim a small amount
              from Monad&rsquo;s faucet using the address above, then come back — you only need to
              do this once.
            </p>
            <a
              href={MONAD_FAUCET_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-block text-[12px] text-accent-bright underline underline-offset-2"
            >
              Open the Monad testnet faucet
            </a>
          </div>
        )}
      </Plate>
    </section>
  );
}

function FundingPanel({
  busy,
  run,
  pool,
}: {
  busy: Busy;
  run: (kind: Exclude<Busy, null>, action: () => Promise<string | null>) => Promise<void>;
  /** Null while the session is locked, which the deposit button below refuses on. */
  pool: ShieldedPool | null;
}) {
  const [amount, setAmount] = React.useState('');
  const parsed = parseAmount(amount);
  // Both actions below re-acquire the signer, and both must re-acquire the SAME one. The faucet
  // sends to whatever address it is handed and the deposit spends from it, so a wallet that has
  // since switched accounts would top up an account this session cannot see.
  const { user } = useSession();

  return (
    <section className="space-y-4">
      <Explain
        label="How adding funds works"
        detail={
          <>
            <p>
              Test collateral is rate-limited so no single tester can distort the books. Claiming
              it sends a transaction from your public address, so it needs a little MON for gas.
            </p>
            <p>
              Depositing is the one public step — everything after it, every bet and every payout,
              is unlinkable.
            </p>
            <p className="text-ink-mute">
              Your wallet will ask twice: once to approve exactly this amount, then once for the
              deposit itself. We never request an unlimited spending cap.
            </p>
          </>
        }
      >
        Add funds
      </Explain>
      <Plate className="space-y-5 p-4 sm:p-6">
        <div className="space-y-2">
          <Button
            disabled={busy !== null}
            onClick={() =>
              void run('faucet', async () => {
                const signer = await reconnectWallet(user?.address);
                try {
                  const remaining = await faucetCooldown(COLLATERAL_ADDRESS, signer.address);
                  if (remaining > 0n) {
                    return `Faucet available again in ${formatDuration(remaining)}.`;
                  }
                  const hash = await claimTestTokens({
                    token: COLLATERAL_ADDRESS,
                    wallet: await signerWalletClient(signer),
                  });
                  return `Test collateral claimed (${hash.slice(0, 10)}…).`;
                } finally {
                  signer.disconnect?.();
                }
              })
            }
          >
            {busy === 'faucet' ? 'Claiming…' : 'Get test collateral'}
          </Button>
        </div>

        <Rule />

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="folio block">Deposit into the pool</span>
            <input
              className="field w-full"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Deposit amount"
            />
          </label>
          {/*
            The two-prompt warning moved into the disclosure above rather than being dropped: it
            still sets expectations before the wallet does, so two confirmations do not read as
            something having gone wrong.
          */}
          <Button
            variant="primary"
            disabled={busy !== null || parsed === null || parsed <= 0n || pool === null}
            onClick={() =>
              void run('deposit', async () => {
                const signer = await reconnectWallet(user?.address);
                try {
                  const available = await publicBalance(COLLATERAL_ADDRESS, signer.address);
                  if (available < parsed!) {
                    throw new Error(
                      `You hold ${formatUsd(available.toString(), COLLATERAL_DECIMALS)} publicly; claim test collateral first.`,
                    );
                  }
                  // Resolves only once the deposit is mined, so the balance we refetch afterwards
                  // is one the user can actually trade with.
                  await pool!.deposit({
                    token: COLLATERAL_ADDRESS,
                    amount: parsed!,
                    wallet: await signerWalletClient(signer),
                  });
                  setAmount('');
                  return 'Deposit complete — your balance is now shielded.';
                } finally {
                  signer.disconnect?.();
                }
              })
            }
          >
            {busy === 'deposit' ? 'Depositing…' : 'Deposit'}
          </Button>
        </div>
        {/* Shielding a deposit crosses the pool and takes tens of seconds. The same wordless
            mark the bet panel draws, so waiting looks the same everywhere money moves. */}
        {busy === 'deposit' && <Waiting label="Shielding your deposit" />}
      </Plate>
    </section>
  );
}

function WithdrawPanel({
  busy,
  run,
  pool,
}: {
  busy: Busy;
  run: (kind: Exclude<Busy, null>, action: () => Promise<string | null>) => Promise<void>;
  pool: ShieldedPool | null;
}) {
  const [amount, setAmount] = React.useState('');
  const [recipient, setRecipient] = React.useState('');
  const parsed = parseAmount(amount);

  return (
    <section className="space-y-4">
      <Explain
        label="Why the destination matters"
        detail={
          <p>
            Use a fresh address. Withdrawing to the account you deposited from links the two sides
            together and undoes the privacy you paid for.
          </p>
        }
      >
        Withdraw
      </Explain>
      <Plate className="space-y-3 p-4 sm:p-6">
        <label className="block space-y-1.5">
          <span className="folio block">Amount</span>
          <input
            className="field w-full"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Withdrawal amount"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="folio block">Destination address</span>
          <input
            className="field w-full"
            placeholder="0x…"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            aria-label="Destination address"
          />
        </label>
        <Button
          disabled={
            busy !== null || parsed === null || parsed <= 0n || recipient.trim() === '' || pool === null
          }
          onClick={() =>
            void run('withdraw', async () => {
              await pool!.withdraw({
                token: COLLATERAL_ADDRESS,
                amount: parsed!,
                recipient: recipient.trim(),
              });
              setAmount('');
              setRecipient('');
              return 'Withdrawal complete.';
            })
          }
        >
          {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
        </Button>
        {busy === 'withdraw' && <Waiting label="Proving and withdrawing" />}
      </Plate>
    </section>
  );
}
