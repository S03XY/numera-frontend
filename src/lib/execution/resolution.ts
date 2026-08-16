import { encodeFunctionData, parseAbi, type Hash, type Hex, type PublicClient } from 'viem';
import { marketAccount, type ExecutionRoot } from './keys';
import { ExecutionError } from './market-account';
import {
  readRelayState,
  signForwardRequest,
  signPermit,
  toRelayPayload,
  type RelayPayload,
} from './relay';

/**
 * Proposing and disputing an outcome, without revealing who is doing it.
 *
 * ## Why this is not just "another button"
 *
 * Whoever proposes an outcome is, overwhelmingly, someone holding it. Proposing "Argentina wins"
 * from a login wallet tells anyone reading the chain that this wallet probably holds Argentina —
 * a link between a public identity and a shielded position, and precisely the link every other part
 * of this product exists to prevent.
 *
 * So a proposal goes out exactly the way a bet does: signed by the market account that placed the
 * bets, relayed by us, `_msgSender()` resolving to that account. The proposer never holds gas and
 * never needs to. The same is true of a dispute, and more obviously so — a disputer is usually
 * holding the other side.
 *
 * ## What is different from trading
 *
 * A separate forwarder, with its own EIP-712 domain name and its own two-selector allowlist. That
 * separation is deliberate rather than incidental: a forwarder whose destination can change, or
 * whose allowlist can grow, is a general-purpose relayer wearing a costume.
 *
 * And a bond. Every call here stakes collateral in the same transaction, which is what makes it
 * safe to leave the relay endpoint open — a spammer has to lock money worth many times the gas they
 * cost us, and only gets it back by being right.
 */

/** `OptimisticResolver.INVALID_OUTCOME` — the sentinel meaning "void this market". */
export const INVALID_OUTCOME = 4_294_967_295n;

/** Matches `ResolutionForwarder.MAX_RELAY_GAS`. Requests above this are rejected on chain. */
export const MAX_RESOLUTION_GAS = 500_000n;

/**
 * Gas declared on a relayed proposal.
 *
 * Proposing is a token transfer plus a struct write — an order of magnitude below a trade — so this
 * is generous while staying under the cap. It bounds only what the forwarder *forwards*; the relayer
 * sets its own transaction limit from simulation, which on Monad, where the gas limit is billed
 * rather than the gas used, is what actually determines cost.
 */
export const RESOLUTION_GAS = 350_000n;

/** The forwarder's EIP-712 domain name. Part of the separator — see {@link signForwardRequest}. */
export const RESOLUTION_DOMAIN = 'Numera Resolution Forwarder';

/**
 * The two functions the resolution forwarder will relay.
 *
 * `finalize` is deliberately absent and is not an oversight: it pays the reward to whoever is on
 * record as the proposer, whoever calls it, so the caller is not the beneficiary and has nothing to
 * hide. Anyone may send it themselves, from any address.
 */
export const RESOLVER_ABI = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function dispute(address market, uint256 marketId, uint256 counterOutcomeId)',
]);

/** Posts a signed proposal to the relayer. Injected so this can be tested without a network. */
export interface ResolutionRelayClient {
  submitResolution(payload: RelayPayload): Promise<{ hash: string }>;
}

export interface ResolutionContext {
  root: ExecutionRoot;
  /** Backend market UUID — the account-derivation input, not the on-chain id. */
  marketRef: string;
  token: string;
  rpc: PublicClient;
  chainId: number;
  relay: ResolutionRelayClient;
  /** `ResolutionForwarder`. */
  forwarder: `0x${string}`;
  /** `OptimisticResolver`: the forwarder's only destination, and the bond's spender. */
  resolver: `0x${string}`;
  /** The engine the market lives on. Passed to the resolver as the `market` argument. */
  engine: `0x${string}`;
}

export interface ResolutionResult {
  hash: Hash;
  /** The account now on record. Shown so a proposer can verify it on an explorer. */
  account: `0x${string}`;
}

export interface ProposeParams {
  marketId: bigint;
  /** The asserted outcome index, or `null` to assert the market should be voided. */
  outcomeId: number | null;
  /** Bond plus fee, from the live terms endpoint. Used to size the approval. */
  stake: bigint;
}

export interface DisputeParams {
  marketId: bigint;
  /** What the disputer says the answer actually is, or `null` for "void it". */
  counterOutcomeId: number | null;
  stake: bigint;
}

/** Assert an outcome, staking a bond on being right. */
export async function proposeOutcome(
  ctx: ResolutionContext,
  params: ProposeParams,
): Promise<ResolutionResult> {
  return relayResolution(ctx, {
    data: encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: 'propose',
      args: [ctx.engine, params.marketId, outcomeArg(params.outcomeId)],
    }),
    stake: params.stake,
    label: 'proposal',
  });
}

/** Stake an equal bond that the standing proposal is wrong, and say what the answer is. */
export async function disputeOutcome(
  ctx: ResolutionContext,
  params: DisputeParams,
): Promise<ResolutionResult> {
  return relayResolution(ctx, {
    data: encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: 'dispute',
      args: [ctx.engine, params.marketId, outcomeArg(params.counterOutcomeId)],
    }),
    stake: params.stake,
    label: 'dispute',
  });
}

/** `null` means "void this market", which the contract spells as a sentinel rather than a flag. */
function outcomeArg(outcomeId: number | null): bigint {
  return outcomeId === null ? INVALID_OUTCOME : BigInt(outcomeId);
}

async function relayResolution(
  ctx: ResolutionContext,
  params: { data: Hex; stake: bigint; label: string },
): Promise<ResolutionResult> {
  if (params.stake < 0n) {
    throw new ExecutionError('A stake cannot be negative.', { code: 'invalid' });
  }

  const signer = marketAccount(ctx.root, ctx.marketRef);
  const state = await readRelayState({
    rpc: ctx.rpc,
    forwarder: ctx.forwarder,
    token: ctx.token as `0x${string}`,
    // The resolver pulls the bond, so it is the resolver's allowance that matters here — not the
    // engine's, which is what the trading path reads.
    spender: ctx.resolver,
    account: signer.address,
  });

  // The account holds no gas and can never send `approve`, so the allowance arrives as an EIP-2612
  // signature bundled with the bonded call. Bundled rather than sent alone, so there is never an
  // approval sitting behind a proposal that was never made.
  const permit =
    state.allowance < params.stake
      ? await signPermit({
          account: signer,
          token: ctx.token as `0x${string}`,
          tokenName: state.tokenName,
          tokenVersion: state.tokenVersion,
          spender: ctx.resolver,
          chainId: ctx.chainId,
          nonce: state.permitNonce,
        })
      : undefined;

  const request = await signForwardRequest({
    account: signer,
    forwarder: ctx.forwarder,
    chainId: ctx.chainId,
    to: ctx.resolver,
    data: params.data,
    nonce: state.forwarderNonce,
    gas: RESOLUTION_GAS,
    maxGas: MAX_RESOLUTION_GAS,
    domainName: RESOLUTION_DOMAIN,
  });

  let hash: Hash;
  try {
    const result = await ctx.relay.submitResolution(toRelayPayload(request, permit));
    hash = result.hash as Hash;
  } catch (err) {
    throw translateFailure(err, params.label);
  }

  try {
    const receipt = await ctx.rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new ExecutionError(
        `Your ${params.label} was rejected. Nothing was staked.`,
        { code: 'rejected', cause: new Error(hash) },
      );
    }
  } catch (err) {
    if (err instanceof ExecutionError) throw err;
    // Submitted and undecided. Saying "it failed" here is what makes someone stake twice.
    throw new ExecutionError(
      `Your ${params.label} was submitted and has not settled yet. Check before trying again, so ` +
        `you do not stake twice.`,
      { code: 'pending', cause: err },
    );
  }

  return { hash, account: signer.address };
}

/**
 * Turn a relayer failure into something the proposer can act on.
 *
 * The distinction that matters is whether anything was staked. The relayer simulates before it
 * broadcasts, so its rejections are pre-broadcast by construction and "nothing was staked" is a
 * promise this can actually keep.
 */
function translateFailure(err: unknown, label: string): ExecutionError {
  const message = (err instanceof Error ? err.message : String(err)).trim();

  if (/too many|paused for today|unavailable|not available|503/i.test(message)) {
    return new ExecutionError(
      `Sponsored ${label}s are busy right now, so nothing was staked. Try again in a moment.`,
      { code: 'pool', cause: err },
    );
  }

  /*
    Prefer what the relayer actually said.

    This used to pattern-match every rejection into one guess: "somebody may have got there first,
    or the window may have closed." That sentence was invented here, and it was wrong for the most
    common failure of all — an account without the collateral to cover the bond, which the relayer
    had already identified precisely. Guessing a cause that reads plausibly is worse than admitting
    to none, because the reader acts on it.

    The relayer's own sentences already end with "Nothing was sent and nothing was spent", so the
    one thing that must always be said is said either way.
  */
  if (message && /nothing was (sent|staked|spent)/i.test(message)) {
    return new ExecutionError(message, { code: 'rejected', cause: err });
  }
  if (/could not be verified|expired/i.test(message)) {
    return new ExecutionError(
      `Your ${label} was not accepted, and may have expired before it reached us. Nothing was ` +
        `staked, so it is safe to try again.`,
      { code: 'rejected', cause: err },
    );
  }
  return new ExecutionError(`Your ${label} could not be submitted. Nothing was staked.`, {
    code: 'rejected',
    cause: err,
  });
}

/** The default relay client: posts to the backend, which holds the only funded key. */
export function httpResolutionRelay(baseUrl: string): ResolutionRelayClient {
  return {
    async submitResolution(payload) {
      // No credentials, exactly as with trading. A session cookie here would put the
      // user↔account link in our own logs, which is the one thing this architecture prevents.
      const response = await fetch(`${baseUrl}/api/relay/resolution`, {
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
    },
  };
}
