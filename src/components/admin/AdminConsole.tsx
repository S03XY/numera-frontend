'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/lib/api/endpoints';
import { formatMon, formatUsd, toBigInt } from '@/lib/format';
import { useSession } from '@/lib/auth/useSession';
import { useOperatorResolution, type MarketTarget } from '@/lib/admin/useResolveMarket';
import { useMarket } from '@/lib/hooks/useMarkets';
import { useNow } from '@/lib/useNow';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/Feedback';
import { Datum, Folio, Plate, Rule, SectionHead, Seal } from '@/components/ui/primitives';
import { CopyButton } from '@/components/ui/CopyButton';
import type { AwaitingResolution, LiveResolution } from '@/lib/api/types';
import { BarStack, RowStack, useDelayedFlag } from '@/components/ui/Waiting';

const DECIMALS = 6;

/** `OptimisticResolver` and `ResolverMultisig`, from the deployment. */
const RESOLVER = (process.env.NEXT_PUBLIC_OPTIMISTIC_RESOLVER ?? '') as string;
const MULTISIG = (process.env.NEXT_PUBLIC_RESOLVER_MULTISIG ?? '') as string;

/**
 * Operator console.
 *
 * Three properties worth stating, because they are what make this safe to expose:
 *
 *  - **Authority is on-chain.** Visibility comes from `GET /api/admin/me`, which reads AccessControl
 *    roles from the resolvers. There is no database "is admin" flag to flip, and hiding the nav is
 *    presentation only — every backend route re-checks the role.
 *  - **The server cannot settle.** Every action below is signed by the operator's own wallet, so
 *    compromising our API still cannot resolve a market.
 *  - **A proposal from here is not final.** Proposing costs the operator no bond, but it opens the
 *    same challenge window as a stranger's, and can be overturned by the same quorum. That is what
 *    keeps "the operator can settle quickly" from meaning "the operator decides".
 */
export function AdminConsole() {
  const { status } = useSession();

  const roles = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: ({ signal }) => endpoints.admin.me(signal),
    enabled: status === 'authenticated',
    retry: false,
  });

  const operations = useQuery({
    queryKey: ['admin', 'operations'],
    queryFn: ({ signal }) => endpoints.admin.operations(signal),
    enabled: roles.data?.isOperator === true,
    refetchInterval: 20_000,
  });

  // Held back briefly so a fast read does not flash a placeholder for one frame.
  const showOperationsLoading = useDelayedFlag(operations.isPending);

  if (status !== 'authenticated') {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title="Sign in to continue"
          description="The console shows the on-chain roles held by your connected wallet."
        />
      </div>
    );
  }

  if (roles.isPending) {
    return (
      <div className="space-y-6">
        <Header />
        <BarStack lines={[30, 24, 18]} label="Reading your roles" />
      </div>
    );
  }

  if (!roles.data?.isOperator) {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title="This wallet holds no protocol roles"
          description="Settlement is gated on on-chain roles. Ask an admin to grant RESOLVER_ROLE to your address."
        />
        <Plate className="p-4 sm:p-5">
          <dl className="space-y-2">
            <Datum
              label="Your address"
              value={<span className="mono break-all">{roles.data?.address}</span>}
            />
          </dl>
        </Plate>
      </div>
    );
  }

  const awaiting = operations.data?.awaitingProposal ?? [];
  const disputed = operations.data?.disputed ?? [];
  const finalizable = operations.data?.finalizable ?? [];

  return (
    <div className="space-y-10">
      <Header />

      <section className="space-y-4">
        <SectionHead>Your roles</SectionHead>
        <Plate className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap gap-2">
            {roles.data.roles.map((r) => (
              <Seal key={r}>{r}</Seal>
            ))}
          </div>
          <Rule />
          <dl className="space-y-2">
            <Datum
              label="Wallet"
              value={<span className="mono break-all">{roles.data.address}</span>}
            />
          </dl>
        </Plate>
      </section>

      <RelayGaugePanel />

      {/* Disputes first: they are the only queue with a deadline attached, and the only one where
          doing nothing costs somebody money — an unruled dispute unwinds and returns both stakes. */}
      <section className="space-y-4">
        <SectionHead right={disputed.length > 0 ? <Folio>{disputed.length} open</Folio> : null}>
          Disputes
        </SectionHead>

        {showOperationsLoading && <RowStack rows={2} label="Loading disputes" />}
        {!operations.isPending && disputed.length === 0 && (
          <EmptyState
            title="No disputes"
            description="A market appears here when somebody stakes against a proposed result. Only the signer quorum can decide one."
          />
        )}

        <div className="space-y-4">
          {disputed.map((r) => (
            <DisputeCard key={`${r.address}:${r.marketId}`} row={r} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHead
          right={finalizable.length > 0 ? <Folio>{finalizable.length} ready</Folio> : null}
        >
          Ready to settle
        </SectionHead>

        {!operations.isPending && finalizable.length === 0 && (
          <EmptyState
            title="Nothing waiting to settle"
            description="Proposals appear here once their challenge window has closed unchallenged. Anyone can settle them, which is a convenience rather than an authority."
          />
        )}

        <div className="space-y-4">
          {finalizable.map((r) => (
            <FinalizeCard key={`${r.address}:${r.marketId}`} row={r} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHead right={awaiting.length > 0 ? <Folio>{awaiting.length} waiting</Folio> : null}>
          Awaiting a result
        </SectionHead>

        {showOperationsLoading && <RowStack rows={3} label="Loading markets awaiting a result" />}
        {!operations.isPending && awaiting.length === 0 && (
          <EmptyState
            title="Nothing to propose"
            description="Markets appear here once their close time has passed and nobody has proposed a result."
          />
        )}

        <div className="space-y-4">
          {awaiting.map((m) => (
            <ProposeCard key={m.id} market={m} />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * The gas relayer, in figures, for the people who can do something about them.
 *
 * Numera pays the network fee on every bet, so this account running dry stops betting for
 * everybody. Traders are told a state and nothing more — a balance is not actionable by them, and
 * published beside the daily cap it would tell whoever is draining us exactly how close they are.
 * Here it is the opposite: this is the one screen whose reader can top the account up, so it gets
 * the whole gauge.
 *
 * Watch the spend against the cap rather than the balance alone. A drain shows up there first; a
 * balance is a lagging indicator, and watching only the balance is how the previous relayer kept
 * surprising us at 0.67 MON.
 */
function RelayGaugePanel() {
  const relay = useQuery({
    queryKey: ['admin', 'relay'],
    queryFn: ({ signal }) => endpoints.admin.relay(signal),
    refetchInterval: 30_000,
    retry: false,
  });

  const gauge = relay.data;
  const spent = toBigInt(gauge?.spentTodayWei ?? '0') ?? 0n;
  const cap = toBigInt(gauge?.dailyCapWei ?? '0') ?? 0n;
  // Integer percent, because a gas budget is not a precision instrument and a jittering decimal in
  // an ops readout invites reading noise as signal.
  const usedPct = cap > 0n ? Number((spent * 100n) / cap) : 0;

  return (
    <section className="space-y-4">
      <SectionHead
        right={
          gauge ? (
            <Folio>{gauge.enabled ? (gauge.lowBalance ? 'Low' : 'Funded') : 'Off'}</Folio>
          ) : null
        }
      >
        Gas relayer
      </SectionHead>

      {relay.isPending && <BarStack lines={[26, 20]} label="Reading the relayer" />}

      {relay.isError && (
        <EmptyState
          title="Could not read the relayer"
          description="The gauge is unavailable, which is not the same as the relayer being down. Check the backend logs."
        />
      )}

      {gauge && (
        <Plate className="space-y-3 p-4 sm:p-5">
          <dl className="space-y-2">
            <Datum
              label="Balance"
              value={gauge.balanceWei === null ? 'Unreadable' : formatMon(BigInt(gauge.balanceWei))}
              // Unreadable is not empty: an RPC that did not answer must not present as a drained
              // relayer and send somebody topping up an account that is fine.
              tone={gauge.lowBalance ? 'neg' : undefined}
            />
            <Datum label="Spent today" value={`${formatMon(spent)} of ${formatMon(cap)}`} />
            <Datum label="Budget used" value={`${usedPct}%`} tone={usedPct >= 80 ? 'neg' : undefined} />
            <Datum label="Floor" value={formatMon(toBigInt(gauge.minBalanceWei) ?? 0n)} />
          </dl>
          <Rule />
          <dl className="space-y-2">
            <Datum
              label="Relayer"
              value={
                gauge.relayer ? (
                  <span className="flex items-center gap-2">
                    <span className="mono break-all">{gauge.relayer}</span>
                    <CopyButton value={gauge.relayer} label="relayer address" />
                  </span>
                ) : (
                  'Not configured'
                )
              }
            />
            <Datum label="Sponsored resolution" value={gauge.resolution ? 'On' : 'Off'} />
          </dl>
          {usedPct >= 80 && (
            <p role="note" className="text-[11px] leading-relaxed text-neg">
              Betting stops for everybody when the cap is reached, and resumes at midnight UTC.
              Raise RELAY_DAILY_CAP_MON, or find out what is spending it.
            </p>
          )}
        </Plate>
      )}
    </section>
  );
}

function Header() {
  return (
    <header>
      <h1 className="h-sec">Operations</h1>
      <p className="mt-2.5 max-w-[62ch] text-[14px] leading-relaxed text-ink-dim">
        Every action here is signed by your own wallet, never by our servers, so a compromised API
        still cannot resolve a market. Proposing a result costs you no stake, and is not final: it
        opens the same challenge window anyone else&rsquo;s proposal would.
      </p>
    </header>
  );
}

function target(row: { address: string; marketId: string }): MarketTarget {
  return { resolver: RESOLVER, market: row.address, marketId: BigInt(row.marketId) };
}

/** Shared shell so the three cards look and behave alike. */
function Card({
  title,
  meta,
  children,
  done,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  done: string | null;
}) {
  if (done) {
    return (
      <Plate className="space-y-2 p-4 sm:p-5">
        <p className="text-[14px] text-ink">{title}</p>
        <p className="text-[12px] text-accent-bright">Done.</p>
        <p className="mono break-all text-[11px] text-ink-mute">{done}</p>
      </Plate>
    );
  }
  return (
    <Plate className="space-y-4 p-4 sm:p-5">
      <div>
        <p className="text-[14px] text-ink">{title}</p>
        {meta && <p className="mt-1 flex flex-wrap items-center gap-3">{meta}</p>}
      </div>
      {children}
    </Plate>
  );
}

/** Pick a winner, or void. `null` is a real choice here, so it is never conflated with "unset". */
function OutcomePicker({
  outcomes,
  choice,
  onChoose,
  exclude,
}: {
  outcomes: Array<{ index: number; label: string }>;
  choice: number | null | undefined;
  onChoose: (v: number | null) => void;
  exclude?: number | null;
}) {
  return (
    <fieldset>
      <legend className="folio mb-2">Result</legend>
      <div className="grid gap-px bg-line">
        {outcomes
          .filter((o) => o.index !== exclude)
          .map((o) => (
            <button
              key={o.index}
              type="button"
              aria-pressed={choice === o.index}
              onClick={() => onChoose(o.index)}
              className={`px-3 py-2.5 text-left text-[13px] transition-colors ${
                choice === o.index ? 'bg-accent-wash text-accent-bright' : 'bg-bg hover:bg-bg-2'
              }`}
            >
              {o.label || `Outcome ${o.index + 1}`}
            </button>
          ))}
        <button
          type="button"
          aria-pressed={choice === null}
          onClick={() => onChoose(null)}
          className={`px-3 py-2.5 text-left text-[13px] transition-colors ${
            choice === null ? 'bg-accent-wash text-accent-bright' : 'bg-bg hover:bg-bg-2'
          }`}
        >
          Void, refunding everyone
        </button>
      </div>
    </fieldset>
  );
}

/** A market past close with nothing proposed. The operator asserts a result, without a bond. */
function ProposeCard({ market }: { market: AwaitingResolution }) {
  const queryClient = useQueryClient();
  const { propose, busy } = useOperatorResolution();
  const toast = useToast();
  const detail = useMarket(market.id);
  const [choice, setChoice] = React.useState<number | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const outcomes = detail.data?.outcomes ?? [];
  // Shared ticker rather than Date.now() in render: the latter is impure, so the server and client
  // disagree and the value freezes at first paint.
  const now = useNow();
  const closedAgo =
    now === null ? null : Math.round((now - new Date(market.closeTime).getTime()) / 60_000);

  async function submit() {
    if (choice === undefined) return;
    setError(null);
    const result = await propose(target(market), choice);
    if (!result.ok) {
      if (result.reason !== 'cancelled') {
        setError(result.message);
        toast.error('Not proposed', result.message);
      }
      return;
    }
    setDone(result.txHash);
    toast.success('Result proposed', 'The challenge window is now open. Anyone can dispute it.');
    await queryClient.invalidateQueries({ queryKey: ['admin', 'operations'] });
    await queryClient.invalidateQueries({ queryKey: ['markets'] });
  }

  return (
    <Card
      title={market.title}
      done={done}
      meta={
        <>
          <Folio>{market.engine}</Folio>
          {closedAgo !== null && <Folio>closed {closedAgo}m ago</Folio>}
          <Folio>pot {formatUsd(toBigInt(market.pot) ?? 0n, DECIMALS)}</Folio>
        </>
      }
    >
      <OutcomePicker outcomes={outcomes} choice={choice} onChoose={setChoice} />

      {error && (
        <p role="alert" className="text-[11.5px] leading-relaxed text-neg">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Button
          variant="primary"
          size="sm"
          disabled={choice === undefined || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Proposing…' : 'Propose result'}
        </Button>
        <p className="text-[11.5px] leading-relaxed text-ink-mute">
          This does not settle the market. It opens a challenge window that anyone can stake
          against, and the quorum has the last word if they do.
        </p>
      </div>
    </Card>
  );
}

/** A proposal whose window closed unchallenged. Settling it is permissionless. */
function FinalizeCard({ row }: { row: LiveResolution }) {
  const queryClient = useQueryClient();
  const { finalize, busy } = useOperatorResolution();
  const toast = useToast();
  const { label } = useOutcomeLabels(row.id);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    const result = await finalize(target(row));
    if (!result.ok) {
      if (result.reason !== 'cancelled') {
        setError(result.message);
        toast.error('Not settled', result.message);
      }
      return;
    }
    setDone(result.txHash);
    toast.success('Market settled', 'Winners can now claim.');
    await queryClient.invalidateQueries({ queryKey: ['admin', 'operations'] });
    await queryClient.invalidateQueries({ queryKey: ['markets'] });
  }

  return (
    <Card
      title={row.title}
      done={done}
      meta={
        <>
          <Folio>unchallenged</Folio>
          {row.proposerBonded ? (
            <Folio>staked {formatUsd(toBigInt(row.proposerBond) ?? 0n, DECIMALS)}</Folio>
          ) : (
            <Folio>proposed by the operator</Folio>
          )}
        </>
      }
    >
      <dl className="space-y-2">
        <Datum label="Result" value={label(row.proposedOutcome)} strong />
        {row.proposer && (
          <Datum label="Proposed by" value={<span className="mono break-all">{row.proposer}</span>} />
        )}
      </dl>

      {error && (
        <p role="alert" className="text-[11.5px] leading-relaxed text-neg">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Settling…' : 'Settle market'}
        </Button>
        <p className="text-[11.5px] leading-relaxed text-ink-mute">
          Pays the recorded proposer their stake back plus the reward, whoever sends this.
        </p>
      </div>
    </Card>
  );
}

/** A contested market. Only the quorum can decide it, and only before the timeout. */
function DisputeCard({ row }: { row: LiveResolution }) {
  const queryClient = useQueryClient();
  const { arbitrate, busy } = useOperatorResolution();
  const toast = useToast();
  const { outcomes, label } = useOutcomeLabels(row.id);
  const [choice, setChoice] = React.useState<number | null | undefined>(undefined);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const now = useNow();
  const hoursLeft =
    now === null || !row.arbitrationDeadline
      ? null
      : Math.round((new Date(row.arbitrationDeadline).getTime() - now) / 3_600_000);

  async function submit() {
    if (choice === undefined) return;
    setError(null);
    const result = await arbitrate({ ...target(row), multisig: MULTISIG }, choice);
    setConfirming(false);
    if (!result.ok) {
      if (result.reason !== 'cancelled') {
        setError(result.message);
        toast.error('Not decided', result.message);
      }
      return;
    }
    setDone(result.txHash);
    toast.success(
      'Sent to the quorum',
      'It executes as soon as enough signers agree. The side that was wrong forfeits its stake.',
    );
    await queryClient.invalidateQueries({ queryKey: ['admin', 'operations'] });
    await queryClient.invalidateQueries({ queryKey: ['markets'] });
  }

  return (
    <Card
      title={row.title}
      done={done}
      meta={
        <>
          <Folio>disputed</Folio>
          {hoursLeft !== null && (
            // Not decorative. Past this, anyone can unwind the dispute and both stakes go back,
            // leaving the market unsettled and the work to do again.
            <Folio>{hoursLeft > 0 ? `${hoursLeft}h to decide` : 'past the deadline'}</Folio>
          )}
        </>
      }
    >
      <dl className="space-y-2">
        <Datum label="Proposed" value={label(row.proposedOutcome)} strong />
        <Datum
          label="Proposer"
          value={
            row.proposerBonded ? (
              <span className="mono break-all">{row.proposer}</span>
            ) : (
              'The operator, without a stake'
            )
          }
        />
        <Datum label="Disputed with" value={label(row.counterOutcome)} strong />
        <Datum
          label="Disputer"
          value={<span className="mono break-all">{row.disputer ?? '—'}</span>}
        />
        <Datum label="Each stake" value={formatUsd(toBigInt(row.disputerBond) ?? 0n, DECIMALS)} />
      </dl>

      <OutcomePicker outcomes={outcomes} choice={choice} onChoose={setChoice} />

      {error && (
        <p role="alert" className="text-[11.5px] leading-relaxed text-neg">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="space-y-2 border border-line p-3">
          <p className="text-[12px] leading-relaxed text-ink">
            This settles the market and takes one side&rsquo;s stake. Whichever party asserted
            something other than{' '}
            <span className="text-accent-bright">{label(choice ?? null)}</span> forfeits
            their stake and is barred from trading.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Confirm'}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={choice === undefined || busy}
          onClick={() => setConfirming(true)}
        >
          Decide through the quorum
        </Button>
      )}
    </Card>
  );

}

/**
 * Outcome labels for a market, or a positional fallback.
 *
 * The fallback matters more than it looks. A resolution row can arrive before the market it is
 * about — they are separate contracts on separate indexer streams — and an operator being shown
 * "Outcome 2" is far better than being shown nothing while deciding which side loses its stake.
 */
function useOutcomeLabels(marketRef: string | undefined) {
  const detail = useMarket(marketRef ?? '');
  // Memoised because `?? []` is a fresh array on every render, which would make `label` a new
  // function each time and re-render every card on every tick of the operations poll.
  const outcomes = React.useMemo(() => detail.data?.outcomes ?? [], [detail.data?.outcomes]);
  const label = React.useCallback(
    (index: number | null): string => {
      if (index === null) return 'Void, refunding everyone';
      return outcomes.find((o) => o.index === index)?.label || `Outcome ${index + 1}`;
    },
    [outcomes],
  );
  return { outcomes, label };
}
