import { createWalletClient, http, type Hash, type PublicClient, type WalletClient } from 'viem';
import { monadTestnet, publicClient } from '@/lib/chain/evm';
import { marketAccount, marketAccountAddress, type ExecutionRoot } from './keys';
import type { ShieldedPool } from './pool';

/**
 * The three money flows, without an execution session anywhere.
 *
 * Collateral leaves the shielded pool for an address we derived ourselves, trades from there, and
 * comes home to a private balance. Each leg is one ordinary transaction that either lands or
 * fails; there is no multi-step session to abandon halfway, which is the single behaviour that
 * froze funds under the previous design.
 *
 *     pool ──withdraw──▶ market account ──buy/sell/claim──▶ engine
 *       ▲                      │
 *       └───────deposit────────┘
 *
 * ## Why this is as private as what it replaces
 *
 * The market account is `msg.sender` at the engine, so it — not the user — is the position holder.
 * It is funded by a pool withdrawal whose *source account is private*, and it returns collateral
 * by a deposit whose *recipient is private*. Neither leg names the user, which is exactly the
 * exposure a sponsored execution session had: the vendor's own documentation says `execute()` "has
 * the same exposure as a withdrawal".
 *
 * ## The one rule that must never be broken
 *
 * **Nothing the user's own wallet does may ever touch a market account.** A single public transfer
 * from their address to it — even dust, even for gas — publishes the link this whole design
 * exists to break, permanently and retroactively for every position that account will ever hold.
 * Gas is provided by {@link GasProvider}, and the only correct implementations are ones the user's
 * wallet is not party to.
 */

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(message: string, options?: { cause?: unknown; code?: ExecutionErrorCode }) {
    super(message, options);
    this.name = 'ExecutionError';
    this.code = options?.code ?? 'rejected';
  }
}

export type ExecutionErrorCode =
  /** Caller-side validation. Nothing was sent. */
  | 'invalid'
  /** The pool refused or failed the crossing. Nothing moved. */
  | 'pool'
  /** The market account has no gas and none could be provided. */
  | 'no-gas'
  /** Submitted and undecided — never say "nothing happened" for this. */
  | 'pending'
  /** The chain ran it and rejected it. */
  | 'rejected';

/**
 * Whoever pays for a market account's transactions.
 *
 * Injected rather than chosen here, because the right answer is a deployment decision with a
 * privacy constraint attached, and because the endgame removes the question entirely: once the
 * engine is `ERC2771Context` and the collateral is `ERC20Permit`, a market account signs and a
 * relayer sends, so it never holds native gas at all and this becomes a no-op.
 *
 * Until then an implementation must satisfy one property: **the user's wallet is not the source,
 * and no server learns which user an account belongs to.** An authenticated "please fund my market
 * account" endpoint fails the second half as surely as the user's own wallet fails the first.
 */
export interface GasProvider {
  /** Ensure `address` can pay for `transactions` more operations. */
  ensure(params: { address: `0x${string}`; transactions: number }): Promise<void>;
}

/** Everything a money path needs, gathered once. */
export interface ExecutionContext {
  pool: ShieldedPool;
  root: ExecutionRoot;
  gas: GasProvider;
  /** Backend market UUID — the derivation input, not the on-chain id. */
  marketRef: string;
  /** Collateral token address. */
  token: string;
  rpc?: PublicClient;
  /**
   * Builds the wallet that acts as this market's account.
   *
   * Injectable for the same reason `rpc` is: without it these paths cannot be exercised without a
   * funded account and a live chain, and money paths that can only be tested live are money paths
   * that do not get tested. The default derives from the root and is what production uses.
   */
  walletFor?: (root: ExecutionRoot, marketRef: string) => WalletClient;
}

/** The address that holds this market's position. Cheap, and materialises no signer. */
export function addressFor(ctx: Pick<ExecutionContext, 'root' | 'marketRef'>): `0x${string}` {
  return marketAccountAddress(ctx.root, ctx.marketRef);
}

/** A wallet that acts as this market's account. Held for one operation, then dropped. */
function walletFor(ctx: ExecutionContext): WalletClient {
  if (ctx.walletFor) return ctx.walletFor(ctx.root, ctx.marketRef);
  return createWalletClient({
    account: marketAccount(ctx.root, ctx.marketRef),
    chain: monadTestnet,
    transport: http(),
  });
}

const NOTE_MAX = (1n << 120n) - 1n;

/**
 * Shielded pool → this market's account.
 *
 * One `withdraw`. The pool sees a request to pay an address; it does not see, and cannot reveal,
 * which private balance funded it. Nothing is reserved, sessioned, or held: the transfer either
 * completes or fails and releases, which is the entire reason this replaced a funded execute.
 */
export async function fundMarket(
  ctx: ExecutionContext,
  params: { amount: bigint },
): Promise<{ account: `0x${string}` }> {
  if (params.amount <= 0n) {
    throw new ExecutionError('Deposit amount must be greater than zero.', { code: 'invalid' });
  }
  if (params.amount > NOTE_MAX) {
    throw new ExecutionError('Deposit amount exceeds the maximum note size.', { code: 'invalid' });
  }

  const account = addressFor(ctx);
  try {
    await ctx.pool.withdraw({ token: ctx.token, amount: params.amount, recipient: account });
  } catch (err) {
    throw new ExecutionError(
      'The transfer into this market’s account did not go through, and your private balance is ' +
        'untouched. Nothing was reserved — try again in a moment.',
      { code: 'pool', cause: err },
    );
  }
  return { account };
}

/**
 * This market's account → the user's private balance.
 *
 * The counterpart to {@link fundMarket}, and the leg that makes the design honest: money goes back
 * where it came from with no public address in between. The account signs a Permit2 witness and
 * the pool's own infrastructure relays it, so this costs the account nothing in gas — the deposit
 * path sends no transaction of its own.
 *
 * `amount` is read by the caller immediately before the call rather than taken on trust, because
 * a sale settling in between would otherwise leave the difference behind as dust in an account the
 * trader has just been told is empty.
 */
export async function returnToPool(
  ctx: ExecutionContext,
  params: { amount: bigint },
): Promise<void> {
  if (params.amount <= 0n) {
    throw new ExecutionError('There is nothing in this market’s account to withdraw.', {
      code: 'invalid',
    });
  }

  try {
    await ctx.pool.deposit({
      token: ctx.token,
      amount: params.amount,
      // The depositor is this market's account; the recipient is the user's private balance. The
      // pool keeps those independent, which is the whole reason an account can return collateral
      // to a balance it has no other claim on.
      wallet: walletFor(ctx) as never,
    });
  } catch (err) {
    throw new ExecutionError(
      'The transfer back into your private balance did not go through. The collateral is still in ' +
        'this market’s account and nothing was lost.',
      { code: 'pool', cause: err },
    );
  }
}

/**
 * Send one transaction as this market's account and wait for it to land.
 *
 * Every on-chain action a trader takes goes through here, so this is the one place that decides
 * what "it worked" means. A receipt with `status: 'reverted'` is a failure even though the
 * transaction itself succeeded — reading only the hash is how a reverted bet was once reported as
 * placed.
 */
export async function sendAs(
  ctx: ExecutionContext,
  params: { to: string; data: string; label: string },
): Promise<Hash> {
  const rpc = ctx.rpc ?? publicClient();
  const wallet = walletFor(ctx);

  let hash: Hash;
  try {
    hash = await wallet.sendTransaction({
      account: wallet.account!,
      chain: monadTestnet,
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Monad reserves `gasLimit × maxFeePerGas` up front and rejects the broadcast, so an account
    // with *some* gas but not enough fails here rather than on chain. Named, because "insufficient
    // balance" about an account the trader has never seen is meaningless to them.
    if (/insufficient balance|insufficient funds/i.test(message)) {
      throw new ExecutionError(
        'This market’s account could not pay for the transaction. Nothing was sent.',
        { code: 'no-gas', cause: err },
      );
    }
    throw new ExecutionError(`Your ${params.label} was not submitted.`, {
      code: 'rejected',
      cause: err,
    });
  }

  let receipt;
  try {
    receipt = await rpc.waitForTransactionReceipt({ hash });
  } catch (err) {
    // Submitted and undecided. Saying it failed here would invite a duplicate.
    throw new ExecutionError(
      `Your ${params.label} was submitted and has not settled yet. Check before trying again, so ` +
        `you do not do it twice.`,
      { code: 'pending', cause: err },
    );
  }

  if (receipt.status !== 'success') {
    throw new ExecutionError(
      `Your ${params.label} was rejected by the market. Nothing was spent beyond the fee.`,
      { code: 'rejected', cause: new Error(hash) },
    );
  }
  return hash;
}
