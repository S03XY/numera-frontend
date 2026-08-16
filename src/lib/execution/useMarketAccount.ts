'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePool } from '@/lib/pool/PoolProvider';
import { readAccountState } from '@/lib/execution/account-state';
import { applyPending, balanceSubject, pendingBalances, usePending } from '@/lib/optimistic/pending';
import { marketAccountAddress } from './keys';

/**
 * What a market's account holds, ready to trade with.
 *
 * ## Why this replaced the registry-backed version
 *
 * The previous hook resolved the account by looking it up in a local store that Unlink's execution
 * layer wrote to when it allocated a slot. Accounts are **derived** now — a pure function of the
 * user's root secret and the market id — so nothing writes to that store any more. The lookup
 * always missed, the balance query never ran, and a market the trader had just funded showed as
 * empty while their money sat in it.
 *
 * Deriving instead means the address is known the moment the session is unlocked, before any
 * funding, on any device. There is no "set up this market" step left to represent.
 *
 * ## Read from the chain, never from the vendor
 *
 * Asking Unlink "what does this account hold?" would hand their backend a market account alongside
 * an authenticated session — precisely the link this product exists to break. A public `eth_call`
 * names no user.
 *
 * `isError` stays distinct from a zero balance throughout, because the UI gates the trade button on
 * this figure: an RPC that failed to answer must not present as an empty account and refuse a trade
 * the trader can perfectly well afford.
 */

/** How often to re-read. Cheap — two `eth_call`s against a public RPC. */
const BALANCE_REFETCH_MS = 12_000;

export interface MarketAccountBalance {
  /** The derived address, or `null` while the session is locked. */
  address: `0x${string}` | null;
  /**
   * Collateral the account holds, base units — **including a transfer that has not landed yet**.
   *
   * For display. Anything that sizes or gates a transaction wants {@link settledBalance}.
   */
  balance: bigint;
  /** The same figure with no predictions in it. What every decision is made from. */
  settledBalance: bigint;
  /** A deposit or withdrawal is in flight, so {@link balance} is ahead of the chain. */
  pending: boolean;
  /** What the engine may already pull without a fresh approval, base units. */
  allowance: bigint;
  /**
   * No address to read — the session is locked.
   *
   * Distinct from an empty account. Under the old registry this also meant "this market has never
   * been set up on this device", a state that no longer exists: a derived address always exists
   * once unlocked, so the only question left is whether it holds anything.
   */
  unset: boolean;
  isPending: boolean;
  /** The read failed. The balance is unknown, which is not the same as zero. */
  isError: boolean;
  /**
   * A balance has actually been read.
   *
   * `balance` falls back to `0n` so callers need not handle `undefined`, and that fallback is a
   * trap: an unread balance and an empty account are different facts, and the UI gates a trade
   * button on this figure. Anything that renders or decides on `balance` must check this first.
   */
  known: boolean;
  /**
   * Re-read now, and resolve with the fresh balance.
   *
   * Returns the figure rather than `void` because the caller that matters is a withdrawal, and a
   * withdrawal is capped at the balance it was given. This polls every twelve seconds, so a trade
   * settling in between would otherwise leave the difference behind as dust.
   */
  refetch: () => Promise<bigint | null>;
}

/** The address this market trades through, or `null` while locked. */
export function useMarketAccountAddress(marketRef: string): `0x${string}` | null {
  const { executionRoot } = usePool();
  return React.useMemo(
    () => (executionRoot && marketRef ? marketAccountAddress(executionRoot, marketRef) : null),
    [executionRoot, marketRef],
  );
}

export function useMarketAccountBalance(params: {
  marketRef: string;
  token: string;
  /** Engine contract, for the allowance leg. */
  spender: string;
  enabled?: boolean;
}): MarketAccountBalance {
  const { marketRef, token, spender, enabled = true } = params;
  const address = useMarketAccountAddress(marketRef);

  const query = useQuery({
    queryKey: ['execution', 'market-account', address, token, spender],
    queryFn: () => readAccountState({ token, owner: address!, spender }),
    enabled: enabled && address !== null && Boolean(token) && Boolean(spender),
    refetchInterval: BALANCE_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const confirmed = query.data?.balance ?? 0n;
  const subject = address && token ? balanceSubject(address, token) : null;
  const predictions = usePending(pendingBalances, subject);

  /* Retire a prediction once the chain read has moved. In an effect: a render must not write. */
  React.useEffect(() => {
    if (query.data === undefined || subject === null) return;
    pendingBalances.reconcile((s) => (s === subject ? confirmed : undefined));
  }, [query.data, subject, confirmed]);

  // Only entries still describing the figure we last confirmed. One that does not is describing a
  // read that has already landed, and adding it again would double the transfer on screen.
  const live = predictions.filter((e) => e.witness === confirmed);
  const shown = applyPending(live, { value: confirmed });

  return {
    address,
    balance: shown.value,
    /**
     * The confirmed figure, for anything that decides rather than draws.
     *
     * A prediction must never let somebody sign a transaction they cannot cover: a buy sized
     * against money that has not arrived is a revert, and on Monad a revert is billed at the full
     * declared gas limit. So affordability, the withdrawal cap and the resolution stake check all
     * read this, while the panel shows {@link balance}.
     */
    settledBalance: confirmed,
    pending: shown.pending,
    allowance: query.data?.allowance ?? 0n,
    unset: address === null,
    isPending: address !== null && query.isPending,
    isError: query.isError,
    known: query.data !== undefined,
    // `null` on a failed read, never `0n`: a caller that treated an unreadable balance as empty
    // would sweep nothing and call it done.
    refetch: async () => (await query.refetch()).data?.balance ?? null,
  };
}

/**
 * Whether this market's account is holding collateral.
 *
 * Used to show a position panel before the indexer has caught up. Under the registry this asked
 * "does this browser know an account here?", which no longer distinguishes anything — every market
 * has a derived address. Holding a balance does distinguish: it means the trader has funded this
 * market and something is either in flight or ready to trade.
 */
export function useHasMarketAccount(marketRef: string, token: string, spender: string): boolean {
  const { balance } = useMarketAccountBalance({ marketRef, token, spender });
  return balance > 0n;
}
