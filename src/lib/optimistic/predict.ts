'use client';

import {
  balanceSubject,
  pendingBalances,
  pendingPositions,
  positionSubject,
} from './pending';

/**
 * Turning a trade into the figures it is about to change.
 *
 * Kept out of the ticket because it is the one piece of this that is easy to get quietly wrong: a
 * NO is not an outcome, it is one share of every *other* outcome, and a prediction that forgets
 * that draws a position on the wrong row. The four-way map already exists in the ticket for what to
 * send on chain; this is the same map for what to show, in one place, so the two cannot disagree
 * about what a bet does.
 *
 * Everything here is a display prediction. Nothing sizes a transaction. See `pending.ts`.
 */

export interface TradePrediction {
  /** The market account, or null while the session is locked — then there is nothing to predict. */
  account: string | null;
  marketRef: string;
  token: string;
  /** The confirmed balance this prediction is made against, and the witness it retires on. */
  balance: bigint;
  /** Outcome indices this trade adds to or removes from. */
  legs: number[];
  /** Shares per leg, base units. */
  shares: bigint | null;
  /** Collateral moving, base units: spent on a buy, received on a sale. */
  money: bigint | null;
  side: 'buy' | 'sell';
  /** Confirmed shares per outcome, for the witness and for scaling a sale's cost basis. */
  held: Map<number, bigint>;
  /** Confirmed cost basis across this market, base units. */
  basis: bigint;
}

/** Register the prediction. Returns the revert, to call if the trade does not happen. */
export function predictTrade(p: TradePrediction): () => void {
  if (!p.account || p.shares === null || p.shares <= 0n || p.legs.length === 0) return () => {};

  const money = p.money ?? 0n;
  const legs = BigInt(p.legs.length);
  const undo: Array<() => void> = [];

  /*
    Cost basis, per leg.

    A buy divides what it spent across the legs it bought. A sale releases basis in proportion to
    how much of the market's whole position is leaving — every share held here, not just the legs
    being sold — because the basis figure this is derived from is the market-wide one and there is
    no per-leg breakdown to divide instead. Approximate, and it only ever colours the unrealised
    P&L line for the second or two before the indexer replaces it with the real figure.
  */
  const heldEverywhere = [...p.held.values()].reduce((sum, n) => sum + n, 0n);
  const leaving = p.shares * legs;
  const releasedPerLeg =
    p.side === 'sell' && heldEverywhere > 0n ? -((p.basis * leaving) / heldEverywhere) / legs : 0n;

  for (const [index, leg] of p.legs.entries()) {
    // The last leg takes the remainder, so the parts add back up to the money that actually moved
    // rather than to a rounded-down approximation of it.
    const even = money / legs;
    const spentHere = index === p.legs.length - 1 ? money - even * (legs - 1n) : even;

    undo.push(
      pendingPositions.add({
        subject: positionSubject(p.account, p.marketRef, leg),
        delta: p.side === 'buy' ? p.shares : -p.shares,
        secondary: p.side === 'buy' ? spentHere : releasedPerLeg,
        // Per leg, because each row retires on its own figure moving.
        witness: p.held.get(leg) ?? 0n,
      }),
    );
  }

  undo.push(
    pendingBalances.add({
      subject: balanceSubject(p.account, p.token),
      // A buy spends from this account; a sale pays back into it.
      delta: p.side === 'buy' ? -money : money,
      witness: p.balance,
    }),
  );

  return () => {
    for (const revert of undo) revert();
  };
}

/** A deposit into, or a withdrawal out of, a market account. */
export function predictTransfer(params: {
  account: string | null;
  token: string;
  balance: bigint;
  /** Signed: positive for a deposit, negative for a withdrawal. */
  delta: bigint;
}): () => void {
  if (!params.account || params.delta === 0n) return () => {};
  return pendingBalances.add({
    subject: balanceSubject(params.account, params.token),
    delta: params.delta,
    witness: params.balance,
  });
}

/**
 * Collecting a settled position.
 *
 * The shares stay on screen and the line flips to collected, which is what the contract does:
 * `redeem` marks the position paid, it does not delete it. Predicting a disappearance would be a
 * prettier lie and a worse one, because the row comes back at the next poll.
 */
export function predictClaim(params: {
  account: string;
  marketRef: string;
  outcomeIndex: number;
  /** Confirmed shares, the witness this retires on. */
  shares: bigint;
}): () => void {
  return pendingPositions.add({
    subject: positionSubject(params.account, params.marketRef, params.outcomeIndex),
    delta: 0n,
    collected: true,
    witness: params.shares,
  });
}
