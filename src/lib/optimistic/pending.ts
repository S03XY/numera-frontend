'use client';

import * as React from 'react';

/**
 * Showing the result of an action before the server has heard about it.
 *
 * ## Why not `setQueryData`
 *
 * The usual optimistic pattern writes the expected value into the query cache and lets the next
 * fetch replace it. That works when the server is the only thing behind the request. Here it is
 * not: a bet is relayed on chain, an indexer reads the chain into Postgres, and the API reads
 * Postgres. The screen polls every four seconds. So the sequence for a cache write is: the position
 * appears, four seconds later the poll returns data from *before* the indexer caught up, the
 * position vanishes, and a second or two after that it comes back. A flicker that says "your bet
 * was cancelled, no it wasn't" is worse than the wait it was meant to hide.
 *
 * So an effect is held *over* the server data rather than written into it, and it stays until there
 * is evidence the server has seen the action.
 *
 * ## What counts as evidence
 *
 * Not equality with the predicted figure. Prices move between quoting and settling, so the shares
 * that arrive are rarely the shares that were predicted, and waiting for a match would wait
 * forever. What is reliable is the figure the server reported *before* the action: nobody else can
 * move this trader's position or this account's balance, so the moment that figure changes at all,
 * the server has caught up and the prediction is no longer needed.
 *
 * That is the `witness`. An effect retires when the witness no longer matches, when it is reverted
 * because the action failed, or when it ages out — the last of which is a backstop rather than a
 * mechanism, so that a dropped transaction cannot leave a phantom on screen forever.
 *
 * ## What this is not allowed to do
 *
 * It never invents money that can be spent. Everything downstream that gates on a balance — the
 * trade button's affordability check, the withdrawal cap — reads the *confirmed* figure, because a
 * prediction that lets somebody sign a transaction they cannot cover turns a nicety into a revert
 * they pay for. The overlay is for what a person is told, not for what the code decides.
 */

/** A prediction that has not aged out is still worth drawing; past this it is stale, not pending. */
const MAX_AGE_MS = 90_000;

export interface PendingEntry {
  id: number;
  /** What this is about: one position, or one account's holding of one token. */
  subject: string;
  /** Signed change to the headline figure, base units. */
  delta: bigint;
  /** Signed change to the secondary figure — cost basis, for a position. */
  secondary: bigint;
  /** Settlement flips a flag rather than moving a number. */
  collected: boolean;
  /** The server's figure when this started. The effect retires once that moves. */
  witness: bigint;
  createdAt: number;
}

export interface PendingInput {
  subject: string;
  delta: bigint;
  secondary?: bigint;
  collected?: boolean;
  witness: bigint;
}

/**
 * One store per domain.
 *
 * Deliberately outside React. These are created by an event handler and read by components several
 * levels away that share no ancestor holding the state — a bet is placed in the ticket and shows up
 * in the position panel and the funding panel — and threading a context through all three to carry
 * something that lives for two seconds is more machinery than the problem deserves.
 */
function createPendingStore() {
  let entries: PendingEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  return {
    /** Record a prediction. Returns the revert, to be called if the action fails. */
    add(input: PendingInput): () => void {
      const id = nextId++;
      entries = [
        ...entries,
        {
          id,
          subject: input.subject,
          delta: input.delta,
          secondary: input.secondary ?? 0n,
          collected: input.collected ?? false,
          witness: input.witness,
          createdAt: Date.now(),
        },
      ];
      emit();
      return () => {
        const next = entries.filter((e) => e.id !== id);
        if (next.length === entries.length) return;
        entries = next;
        emit();
      };
    },

    /**
     * Drop everything the server has now confirmed, or that has aged out.
     *
     * Takes the confirmed figure per subject. A subject the caller does not know about is left
     * alone: a position that has not appeared in the API at all is exactly the case this exists
     * for, and reading its absence as "confirmed" would retire the effect the instant it was made.
     */
    reconcile(confirmed: (subject: string) => bigint | undefined): void {
      const now = Date.now();
      const next = entries.filter((e) => {
        if (now - e.createdAt > MAX_AGE_MS) return false;
        const value = confirmed(e.subject);
        return value === undefined || value === e.witness;
      });
      if (next.length === entries.length) return;
      entries = next;
      emit();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Stable across calls until something changes, as `useSyncExternalStore` requires. */
    snapshot(): PendingEntry[] {
      return entries;
    },

    clear(): void {
      if (entries.length === 0) return;
      entries = [];
      emit();
    },
  };
}

export type PendingStore = ReturnType<typeof createPendingStore>;

/** Positions the indexer has not written yet. The slow one, and the reason this module exists. */
export const pendingPositions = createPendingStore();

/**
 * Market-account balances a transfer has not landed in yet.
 *
 * Read straight from the chain rather than from the indexer, so it lags far less — but the money
 * leaving the funding panel is the single most alarming thing on the screen to see happen late,
 * and a deposit that reads as "nothing happened" invites a second deposit.
 */
export const pendingBalances = createPendingStore();

const EMPTY: PendingEntry[] = [];

/** Subscribe to one store, filtered to the subjects a component actually draws. */
export function usePending(store: PendingStore, subject: string | null): PendingEntry[] {
  const all = React.useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    // The server renders no predictions: they are made by a click that has not happened there.
    () => EMPTY,
  );
  return React.useMemo(
    () => (subject === null ? EMPTY : all.filter((e) => e.subject === subject)),
    [all, subject],
  );
}

/** Every pending entry, for a caller that merges across many subjects at once. */
export function useAllPending(store: PendingStore): PendingEntry[] {
  return React.useSyncExternalStore(store.subscribe, store.snapshot, () => EMPTY);
}

/** `position:<account>:<market>:<outcome>` — one holder, one market, one outcome. */
export function positionSubject(account: string, marketRef: string, outcomeIndex: number): string {
  return `position:${account.toLowerCase()}:${marketRef}:${outcomeIndex}`;
}

/** `balance:<account>:<token>` — the collateral one market account holds. */
export function balanceSubject(account: string, token: string): string {
  return `balance:${account.toLowerCase()}:${token.toLowerCase()}`;
}

/** Sum a set of entries into the two figures and the flag they carry. */
export function applyPending(
  entries: PendingEntry[],
  base: { value: bigint; secondary?: bigint; collected?: boolean },
): { value: bigint; secondary: bigint; collected: boolean; pending: boolean } {
  let value = base.value;
  let secondary = base.secondary ?? 0n;
  let collected = base.collected ?? false;
  for (const entry of entries) {
    value += entry.delta;
    secondary += entry.secondary;
    collected = collected || entry.collected;
  }
  return {
    // Never below zero. A sale predicted against a figure the server has since revised down would
    // otherwise render a negative holding, which is not a thing that can exist.
    value: value < 0n ? 0n : value,
    secondary: secondary < 0n ? 0n : secondary,
    collected,
    pending: entries.length > 0,
  };
}
