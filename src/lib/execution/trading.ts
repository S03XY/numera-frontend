import { createWalletClient, erc20Abi, http, type Hash, type Hex, type PublicClient } from 'viem';
import { monadTestnet } from '@/lib/chain/evm';
import { addressFor, ExecutionError, type ExecutionContext } from './market-account';
import {
  encodeRelayableCall,
  readRelayState,
  signForwardRequest,
  signPermit,
  toRelayPayload,
  type RelayableFunction,
  type RelayPayload,
} from './relay';
import { marketAccount } from './keys';

/**
 * Trading, with the trader's identity intact.
 *
 * ## The shape of every operation
 *
 * ```
 *   shielded pool ──withdraw──▶ market account ──signed request──▶ relayer ──▶ engine
 *         ▲                            │
 *         └──────────deposit───────────┘
 * ```
 *
 * Three things are true of every path below, and each replaces something that used to go wrong:
 *
 *  - **No sessions.** Each leg is one operation that lands or fails. There is no multi-step plan to
 *    abandon halfway, which is the single behaviour that froze funds under the previous design: a
 *    failure after `finalize` skipped the release and left a withdrawal at `accepted` forever.
 *  - **No allocation.** The account is derived from `(root, marketRef)`, so there is no slot to be
 *    locked, no registry to lose, and no "restore your positions" step. Losing the browser loses
 *    nothing; the passkey re-derives everything.
 *  - **No gas in the account, ever.** It signs; the relayer sends. A market account that received
 *    native gas from the user's wallet would be linked to them publicly and permanently.
 *
 * ## Where the money is at each moment
 *
 * Between funding and returning, collateral sits in a public account whose *owner* is unknown. That
 * is the intended state, not a gap: the balance is visible, the identity is not. The trader decides
 * how much to leave there, because leaving more saves pool crossings and leaving less keeps more
 * value shielded — a trade-off only they can make.
 */

/** Posts a signed request to the relayer. Injected so trading can be tested without a network. */
export interface RelayClient {
  submit(payload: RelayPayload): Promise<{ hash: string }>;
  /**
   * Submit a standalone approval.
   *
   * Separate from {submit} because it is not a trade and does not go through the forwarder: the
   * relayer sends `permit` straight to the collateral, and restricts the *spender* to the engine or
   * Permit2. It exists for the return leg — see {shieldBalance}.
   */
  permit(payload: RelayPermitPayload): Promise<{ hash: string }>;
}

export interface RelayPermitPayload {
  token: string;
  owner: string;
  spender: string;
  value: string;
  deadline: string;
  v: number;
  r: string;
  s: string;
}

export interface TradeContext extends ExecutionContext {
  relay: RelayClient;
  rpc: PublicClient;
  chainId: number;
  forwarder: `0x${string}`;
  /** The engine contract. Also the only address the forwarder will ever call. */
  engine: `0x${string}`;
  /*
    No `permit2` here any more.

    Unlink pulled deposits through Permit2, so the return leg needed that address, a standalone
    relayed approval to it, and an environment endpoint to learn it from — three moving parts to
    give a gasless account an allowance. Numera's entrypoint pulls directly and takes the permit
    bundled into the same transaction, so the whole apparatus is gone. See `shieldBalance`.
  */
}

export interface TradeResult {
  hash: Hash;
  /** The address that now holds the position. Shown so a trader can verify it on an explorer. */
  account: `0x${string}`;
  /** Collateral moved out of the shielded pool to fund this, if any. */
  withdrawn: bigint;
}

const NOTE_MAX = (1n << 120n) - 1n;

/**
 * The progress messages this layer reports, as constants rather than inline strings.
 *
 * Shared with the progress panel so it advances on a real signal instead of matching prose that
 * either side can reword. The previous panel matched Unlink's session statuses — `prepared`,
 * `user_op_sponsored` and so on — none of which exist now, so it would have sat at step one for
 * the whole trade while the trade completed behind it.
 */
export const TRADE_STATUS = {
  /** Crossing the shielded pool to fund this market's account. */
  funding: 'Moving collateral from your private balance',
  placing: 'Placing your bet',
  closing: 'Closing your position',
  claiming: 'Collecting your winnings',
  /** Crossing back, so the proceeds end up private again. */
  returning: 'Moving the proceeds back to your private balance',
} as const;

export type TradeStatus = (typeof TRADE_STATUS)[keyof typeof TRADE_STATUS];

export interface OpenPositionParams {
  marketId: bigint;
  outcomeId: bigint;
  sharesOut: bigint;
  /** Slippage ceiling, fee inclusive — take it from `quoteBuy`, which already includes the fee. */
  maxCost: bigint;
  /** Short instead of long: buy one share of every outcome except `outcomeId`. */
  complement?: boolean;
  /**
   * Total collateral to leave available in the market account, when more than `maxCost`.
   *
   * Crossing the shielded pool is the expensive leg — a proof plus the pool's bookkeeping, against
   * roughly 300,000 gas for the trade itself — so drawing once for several trades is the largest
   * saving available. It is also *more* private: a withdrawal of exactly one fill's cost is
   * visibly that fill's funding, while a round number covering many trades matches nothing.
   *
   * The caller's choice, not ours, because it moves value out of the shielded pool and into a
   * publicly readable balance.
   */
  funding?: bigint;
  onStatus?: (status: string) => void;
}

/**
 * Open or increase a position.
 *
 * Withdraws only the shortfall: an account already holding enough — from change, a sale, or a
 * deliberate top-up — trades with no pool crossing at all.
 */
export async function openPosition(
  ctx: TradeContext,
  params: OpenPositionParams,
): Promise<TradeResult> {
  const { maxCost, sharesOut } = params;
  if (sharesOut <= 0n) {
    throw new ExecutionError('A bet needs a positive share quantity.', { code: 'invalid' });
  }
  if (maxCost <= 0n) {
    throw new ExecutionError('Bet amount must be greater than zero.', { code: 'invalid' });
  }
  if (maxCost > NOTE_MAX) {
    throw new ExecutionError('Bet amount exceeds the maximum note size.', { code: 'invalid' });
  }

  const account = addressFor(ctx);
  const target = params.funding && params.funding > maxCost ? params.funding : maxCost;

  const held = await readTokenBalance(ctx, account);
  const withdrawn = target > held ? target - held : 0n;
  if (withdrawn > 0n) {
    params.onStatus?.(TRADE_STATUS.funding);
    try {
      await ctx.pool.withdraw({ token: ctx.token, amount: withdrawn, recipient: account });
    } catch (err) {
      throw new ExecutionError(
        'The transfer into this market’s account did not go through, and your private balance is ' +
          'untouched. Nothing was reserved — try again in a moment.',
        { code: 'pool', cause: err },
      );
    }
  }

  params.onStatus?.(TRADE_STATUS.placing);
  const hash = await relayCall(ctx, {
    fn: params.complement ? 'buyComplement' : 'buy',
    args: [params.marketId, params.outcomeId, sharesOut, maxCost],
    label: 'bet',
    // The engine pulls `maxCost`; approve at least that much or the trade reverts on transferFrom.
    needsAllowance: maxCost,
  });

  return { hash, account, withdrawn };
}

export interface ClosePositionParams {
  marketId: bigint;
  outcomeId: bigint;
  sharesIn: bigint;
  /** Slippage floor, net of fees — take it from `quoteSell` / `quoteSellComplement`. */
  minRefund: bigint;
  /** Close a short. Sells every leg of the basket in one atomic call. */
  complement?: boolean;
  /** Move the proceeds back into the shielded pool afterwards. */
  shield?: boolean;
  onStatus?: (status: string) => void;
}

/**
 * Reduce or close a position.
 *
 * A short is a basket, so closing one sells every leg — through `sellComplement`, which does it in
 * a single call. Selling the legs separately would mean a separate relayed transaction each, and a
 * revert partway through would leave the trader holding an unbalanced remainder that is no longer a
 * hedge.
 */
export async function closePosition(
  ctx: TradeContext,
  params: ClosePositionParams,
): Promise<TradeResult> {
  if (params.sharesIn <= 0n) {
    throw new ExecutionError('A sale needs a positive share quantity.', { code: 'invalid' });
  }

  const account = addressFor(ctx);
  params.onStatus?.(TRADE_STATUS.closing);
  const hash = await relayCall(ctx, {
    fn: params.complement ? 'sellComplement' : 'sell',
    args: [params.marketId, params.outcomeId, params.sharesIn, params.minRefund],
    label: 'sale',
  });

  if (params.shield) await shieldBalance(ctx, account, params.onStatus);
  return { hash, account, withdrawn: 0n };
}

export interface ClaimParams {
  marketId: bigint;
  /** Move the winnings back into the shielded pool afterwards. Defaults to true. */
  shield?: boolean;
  onStatus?: (status: string) => void;
}

/**
 * Collect a settled position.
 *
 * Winning shares pay 1:1 and settlement takes no further fee — the trade was charged on the way in.
 * There is no deadline on the engine's claim path, so a late claim is always still payable.
 */
export async function claimWinnings(ctx: TradeContext, params: ClaimParams): Promise<TradeResult> {
  const account = addressFor(ctx);
  params.onStatus?.(TRADE_STATUS.claiming);
  const hash = await relayCall(ctx, {
    fn: 'redeem',
    args: [params.marketId],
    label: 'claim',
  });

  if (params.shield !== false) await shieldBalance(ctx, account, params.onStatus);
  return { hash, account, withdrawn: 0n };
}

/**
 * Move whatever the market account holds back into the shielded pool.
 *
 * The balance is read immediately beforehand rather than taken on trust, because a sale settling in
 * between would otherwise leave the difference behind as dust in an account the trader has just
 * been told is empty.
 *
 * A failure here is reported but never rethrown as a lost trade: the sale or claim already
 * succeeded and the money is safe in the trader's own account. Turning that into an error would
 * invite them to repeat an operation that worked.
 */
export async function shieldBalance(
  ctx: TradeContext,
  account: `0x${string}`,
  onStatus?: (status: string) => void,
): Promise<bigint> {
  const balance = await readTokenBalance(ctx, account);
  if (balance <= 0n) return 0n;

  onStatus?.(TRADE_STATUS.returning);
  const signer = marketAccount(ctx.root, ctx.marketRef);

  /*
    One call, where this used to be three.

    The old shape belonged to a pool that pulled through Permit2: read the allowance, relay a
    standalone permit if it was short, then deposit. Our entrypoint pulls directly and takes the
    permit bundled into the same transaction, so the allowance question, the second round trip and
    the window in which an allowance existed for a deposit that never happened all disappear.

    `sponsored` is the whole instruction: this account holds no native gas and never will, so it
    must sign rather than send. The pool implementation produces both signatures — the permit for
    the allowance, and an EIP-712 `Shield` naming the note — and hands them to the relayer. Neither
    is a prompt the trader sees, because this key was derived in their browser.
  */
  try {
    await ctx.pool.deposit({
      token: ctx.token,
      amount: balance,
      sponsored: true,
      // A wallet client, not a bare account: the pool reads `wallet.account` to know who is
      // depositing, and signs through the client. Passing the account itself produced "this wallet
      // has no account selected" from deep inside the old SDK, on the one path a live probe had
      // never exercised.
      //
      // It signs and never sends. The depositor is this market's account; the recipient is the
      // user's private balance, and the pool keeps those independent — which is what lets an
      // account return value to a balance it has no other claim on.
      wallet: createWalletClient({
        account: signer,
        chain: monadTestnet,
        transport: http(),
      }) as never,
    });
  } catch (err) {
    throw new ExecutionError(
      'Could not move the balance back to your private balance. The money is still in this ' +
        'market’s account and nothing was lost — try again in a moment.',
      { code: 'pool', cause: err },
    );
  }
  return balance;
}


/**
 * Sign one engine call as the market account and hand it to the relayer.
 *
 * The approval rides along on the first trade that needs it. `permit` is a signature rather than a
 * transaction, which is the only reason an account with no gas can grant an allowance at all — and
 * it is bundled rather than sent alone, because a standalone permit relay would let a stranger have
 * us pay for their approvals.
 */
async function relayCall(
  ctx: TradeContext,
  params: {
    fn: RelayableFunction;
    args: readonly unknown[];
    label: string;
    needsAllowance?: bigint;
  },
): Promise<Hash> {
  const signer = marketAccount(ctx.root, ctx.marketRef);
  const state = await readRelayState({
    rpc: ctx.rpc,
    forwarder: ctx.forwarder,
    token: ctx.token as `0x${string}`,
    spender: ctx.engine,
    account: signer.address,
  });

  const permit =
    params.needsAllowance !== undefined && state.allowance < params.needsAllowance
      ? await signPermit({
          account: signer,
          token: ctx.token as `0x${string}`,
          tokenName: state.tokenName,
          tokenVersion: state.tokenVersion,
          spender: ctx.engine,
          chainId: ctx.chainId,
          nonce: state.permitNonce,
        })
      : undefined;

  const request = await signForwardRequest({
    account: signer,
    forwarder: ctx.forwarder,
    chainId: ctx.chainId,
    to: ctx.engine,
    data: encodeRelayableCall(params.fn, params.args) as Hex,
    nonce: state.forwarderNonce,
  });

  let hash: Hash;
  try {
    const result = await ctx.relay.submit(toRelayPayload(request, permit));
    hash = result.hash as Hash;
  } catch (err) {
    throw translateRelayFailure(err, params.label);
  }

  try {
    const receipt = await ctx.rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new ExecutionError(
        `Your ${params.label} was rejected by the market. Nothing was spent.`,
        { code: 'rejected', cause: new Error(hash) },
      );
    }
  } catch (err) {
    if (err instanceof ExecutionError) throw err;
    // Submitted and undecided. Calling this a failure is what makes someone bet twice.
    throw new ExecutionError(
      `Your ${params.label} was submitted and has not settled yet. Check before trying again, so ` +
        `you do not do it twice.`,
      { code: 'pending', cause: err },
    );
  }
  return hash;
}

/**
 * Turn a relayer failure into something a trader can act on.
 *
 * The distinction that matters is whether anything was sent. The relayer simulates before it
 * broadcasts, so its rejections are pre-broadcast by construction — which means "nothing happened"
 * is a promise this can actually keep, unlike the session-based path it replaces.
 */
function translateRelayFailure(err: unknown, label: string): ExecutionError {
  const message = err instanceof Error ? err.message : String(err);

  if (/too many|paused for today|unavailable|503/i.test(message)) {
    return new ExecutionError(
      `Gasless trading is busy right now, so your ${label} was not placed. Nothing was spent — ` +
        `try again in a moment.`,
      { code: 'pool', cause: err },
    );
  }
  if (/rejected|could not be verified|expired/i.test(message)) {
    return new ExecutionError(
      `The market would not accept your ${label}. Nothing was sent and nothing was spent — the ` +
        `price may have moved, so check the quote and try again.`,
      { code: 'rejected', cause: err },
    );
  }
  return new ExecutionError(
    `Your ${label} could not be submitted. Nothing was spent.`,
    { code: 'rejected', cause: err },
  );
}

async function readTokenBalance(ctx: TradeContext, account: `0x${string}`): Promise<bigint> {
  return ctx.rpc.readContract({
    address: ctx.token as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });
}

/** The default relay client: posts to the backend, which holds the only funded key. */
export function httpRelay(baseUrl: string): RelayClient {
  // Deliberately no credentials on either call: sending a session cookie would put the
  // user↔account link in our own logs, which is the one thing this architecture exists to prevent.
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.message ?? `relay returned ${response.status}`);
    }
    return response.json();
  };

  return {
    submit: (payload) => post('/api/relay', payload),
    permit: (payload) => post('/api/relay/permit', payload),
  };
}
