import type { WalletClient } from 'viem';

/**
 * What a trader holds privately, with the caveats intact.
 *
 * A struct rather than a number, and the reason is a bug that reached users. A shielded pool spends
 * whole notes and mints change, so immediately after a trade the change note exists but may not yet
 * be attributed. Collapsing the whole thing to one figure meant a $5 bet made a $500 balance read
 * $0 for a few seconds — the single most alarming thing a wallet can do, and pure presentation: the
 * money was never at risk.
 *
 * So the sync state travels with the number and the UI is obliged to deal with it.
 */
export interface ShieldedBalance {
  /** What to show: spendable plus anything still settling. */
  total: bigint;
  /** Unreserved and available to open a trade right now. */
  spendable: bigint;
  /** Change from a spend that has not resolved yet. Real, just not usable yet. */
  pendingChange: bigint;
  /** The index is behind, so `total` is an **under**-estimate. Never render it as final. */
  syncing: boolean;
}

/**
 * Value a pool has taken but not delivered, so a balance can be explained rather than doubted.
 *
 * Not every pool has this failure mode — Numera's cannot strand value and returns zero — but the
 * shape stays on the interface because a wallet must always be able to answer "why is this less
 * than I expected", and answering it needs the pool's cooperation.
 */
export interface HeldValue {
  /** Total sitting in unfinished operations, base units. */
  total: bigint;
  /** One entry per stuck operation, newest first. */
  operations: Array<{ txId: string; amount: bigint; since: string }>;
}

/**
 * The shielded pool, reduced to what Numera actually needs from one.
 *
 * ## Why this interface exists at all
 *
 * Numera's execution layer needs exactly two things from a privacy pool, and it is worth being
 * precise about how small that is:
 *
 *  - **`withdraw`** — move value to an address of our choosing, with the *source account private*.
 *    That one property is what makes a market account unlinkable: the collateral arrives from the
 *    pool, and nothing on chain says whose it was.
 *  - **`deposit`** — move value back in, crediting a *private recipient*, from any public wallet.
 *    That is how a market account returns collateral to a balance it does not itself own.
 *
 * Everything else — trading, positions, claiming, accounting — happens in accounts we derive and
 * contracts we wrote. The pool is a black box either side of that.
 *
 * ## Why it is an interface, and the day that paid for itself
 *
 * The first version of this was written against a vendor SDK directly. When that vendor's API went
 * away mid-development, unpicking `client.execute()` from the execution layer was a week of work.
 * So it was rewritten as four methods with no vendor types in their signatures.
 *
 * The pool underneath was then replaced outright — see `lib/pool/client.ts`, which is Numera's own
 * — and the execution layer, the trade flow and the wallet screen did not change. That is what this
 * interface is for, and it is the only reason the replacement took hours instead of the week.
 *
 * Note what is deliberately absent. No execution accounts, no sessions, no slots, no sponsored
 * gas, no proof artifacts. Those are all implementation details of one particular pool, and every
 * one of them that leaks into this interface is a line that has to be rewritten when the pool
 * changes.
 */
export interface ShieldedPool {
  /**
   * What the user holds privately, with the caveats intact.
   *
   * Returns the breakdown rather than a number because a pool that spends whole notes and mints
   * change legitimately reports a lower `spendable` than `total` for a while, and collapsing that
   * to one figure is what made a routine top-up look like money disappearing.
   */
  balance(token: string): Promise<ShieldedBalance>;

  /**
   * Public wallet → the user's private balance.
   *
   * `wallet` is the *depositor*, and it need not be the user: a market account returning its float
   * deposits into a private balance it has no other claim on. The recipient is always the identity
   * this pool instance is bound to.
   *
   * `sponsored` says the depositor holds no native gas and never will, so it must authorise by
   * signature and have somebody else send. That is the market-account case, and it is a *statement
   * by the caller* rather than something the pool infers from an empty balance — inferring it would
   * quietly turn any user who happened to be out of MON into a claim on our relayer's budget.
   */
  deposit(params: {
    token: string;
    amount: bigint;
    wallet: WalletClient;
    sponsored?: boolean;
  }): Promise<void>;

  /**
   * The user's private balance → any public address, source unlinkable.
   *
   * The whole privacy budget of the design is spent here. The destination and amount are public;
   * which private account funded it is not.
   */
  withdraw(params: { token: string; amount: bigint; recipient: string }): Promise<void>;

  /**
   * Value the pool has taken but not delivered, so a balance can be explained rather than doubted.
   *
   * Not every pool will have this failure mode; one that cannot strand value should return zero.
   * It stays on the interface because a wallet must always be able to answer "why is this less
   * than I expected", and answering it needs the pool's cooperation.
   */
  held(token: string): Promise<HeldValue>;
}
