import { encodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { marketAccount, type ExecutionRoot } from './keys';

/**
 * Signing a trade that somebody else pays to send.
 *
 * ## Why this file exists
 *
 * A trader's market account must never hold native gas. Not "should not" — must not. Its whole
 * value is that nothing public connects it to the user, and the shortest route to breaking that is
 * a gas transfer: one payment from the user's wallet to the account, even dust, publishes the
 * association permanently and retroactively for every position the account will ever hold.
 *
 * So the account signs and never sends. It produces an EIP-712 `ForwardRequest`, our relayer
 * submits it, and `NumeraForwarder` calls the engine with `_msgSender()` resolving to the account.
 * Nothing here ever touches the user's wallet, and nothing here needs a balance.
 *
 * ## What the relayer is allowed to know
 *
 * A signature, and nothing else. No session, no user id, no auth header. An authenticated relay
 * endpoint would let our own logs record "user X asked to move account Y", reconstructing on our
 * infrastructure exactly the link this design exists to destroy. That is why the abuse defences
 * live in the forwarder's immutable target and selector rules and in the engine's minimum trade
 * size, rather than in an identity check that cannot be built.
 *
 * ## Approvals
 *
 * The engine pulls collateral with `transferFrom`, which needs an allowance, which normally needs a
 * transaction the account cannot send. EIP-2612 `permit` replaces it with a signature. It is
 * submitted bundled with the first trade — never on its own, because a standalone permit relay
 * would let a stranger have us pay for their approvals.
 */

/** Matches `NumeraForwarder.MAX_RELAY_GAS`. Requests above this are rejected on chain. */
export const MAX_RELAY_GAS = 1_000_000n;

/**
 * Gas declared on a relayed call.
 *
 * A measured buy costs ~297k end to end and a four-outcome `buyComplement` is the heaviest
 * relayable call, so this leaves comfortable headroom while staying far under the cap. It bounds
 * only what the forwarder *forwards*; the relayer sets its own transaction limit from simulation,
 * which on Monad — where the gas limit is billed rather than the gas used — is what actually
 * determines cost.
 */
export const RELAY_GAS = 600_000n;

/**
 * How long a signed request stays valid.
 *
 * Long enough to survive a slow relayer and a congested block, short enough that a request captured
 * in transit is worthless before it can be used. It is not a security boundary on its own — the
 * nonce already makes every request single-use — but it bounds how long a *pending* one lingers.
 */
export const RELAY_DEADLINE_SECONDS = 600;

export const FORWARDER_ABI = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function market() view returns (address)',
  'function isRelayable(bytes4 selector) view returns (bool)',
]);

export const PERMIT_ABI = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/**
 * How a token states its EIP-712 domain version.
 *
 * This has to be *discovered*, never assumed. The version is part of the domain separator, so a
 * wrong one produces a signature that recovers to a different address entirely — `permit` then
 * reverts with nothing that points at the cause.
 *
 * And the values genuinely differ: OpenZeppelin's `ERC20Permit` uses `"1"`, Circle's USDC uses
 * `"2"`. Numera settles in USDC, so `"2"` is the case that matters.
 *
 * Two ways to ask, tried in this order:
 *
 *  1. **`version()`** — what USDC actually exposes, and therefore the path that must work.
 *  2. **`eip712Domain()`** (ERC-5267) — newer, and what an OpenZeppelin-based token gives you.
 *     USDC predates it and does not implement it.
 */
export const VERSION_ABI = parseAbi(['function version() view returns (string)']);

export const EIP5267_ABI = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);

/**
 * Last resort, when a token answers neither question.
 *
 * `"1"` is the common default, and it is a *guess* — a token that needs it is a token whose domain
 * we could not verify, so a deployment on such a collateral should confirm the value rather than
 * trust this.
 */
export const PERMIT_VERSION_FALLBACK = '1';

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * The five functions the forwarder will relay, mirroring `NumeraForwarder.isRelayable`.
 *
 * Kept here so the app never builds a request the chain is going to reject. It is a convenience,
 * not a control: the enforcement is on chain, where it survives this file being wrong.
 */
export const RELAYABLE = ['buy', 'buyComplement', 'sell', 'sellComplement', 'redeem'] as const;
export type RelayableFunction = (typeof RELAYABLE)[number];

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  constructor(message: string, options?: { cause?: unknown; code?: RelayErrorCode }) {
    super(message, options);
    this.name = 'RelayError';
    this.code = options?.code ?? 'rejected';
  }
}

export type RelayErrorCode =
  /** Caller-side validation. Nothing was signed or sent. */
  | 'invalid'
  /** The relayer refused before broadcasting. Nothing happened on chain. */
  | 'rejected'
  /** The relayer is unreachable or out of capacity. Nothing happened on chain. */
  | 'unavailable'
  /** Submitted and undecided — never say "nothing happened" for this. */
  | 'pending';

/** A signed request, in the shape `NumeraForwarder.execute` expects. */
export interface ForwardRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  gas: bigint;
  deadline: number;
  data: Hex;
  signature: Hex;
}

/** An EIP-2612 approval, in the shape `executeWithPermit` expects. */
export interface PermitSignature {
  owner: `0x${string}`;
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Sign a `ForwardRequest` as this market's account.
 *
 * `nonce` is read from the forwarder rather than tracked locally: two requests signed against the
 * same nonce means the second is dead on arrival, and a trader who retried a slow trade would get a
 * confusing failure on a request that was perfectly valid when signed.
 */
export async function signForwardRequest(params: {
  account: PrivateKeyAccount;
  forwarder: `0x${string}`;
  chainId: number;
  to: `0x${string}`;
  data: Hex;
  nonce: bigint;
  gas?: bigint;
  /** Unix seconds. Defaults to now + {@link RELAY_DEADLINE_SECONDS}. */
  deadline?: number;
  /**
   * EIP-712 domain name of the forwarder being signed for.
   *
   * Required because there are two forwarders — trading and resolution — with two different names,
   * and the name is part of the domain separator. Signing a proposal against the trading
   * forwarder's name produces a signature that recovers to a different address and verifies
   * nowhere, with no error that says so. Defaulted to the trading name so no existing caller
   * changes behaviour.
   */
  domainName?: string;
  /** Ceiling on `gas`, matching the forwarder's own `MAX_RELAY_GAS`. */
  maxGas?: bigint;
}): Promise<ForwardRequest> {
  const gas = params.gas ?? RELAY_GAS;
  if (gas > (params.maxGas ?? MAX_RELAY_GAS)) {
    throw new RelayError('This request asks for more gas than the relayer will ever forward.', {
      code: 'invalid',
    });
  }

  const deadline = params.deadline ?? Math.floor(Date.now() / 1000) + RELAY_DEADLINE_SECONDS;
  const request = {
    from: params.account.address,
    to: params.to,
    // Always zero. The engine is not payable, and the forwarder rejects anything else.
    value: 0n,
    gas,
    nonce: params.nonce,
    deadline,
    data: params.data,
  } as const;

  const signature = await params.account.signTypedData({
    domain: {
      name: params.domainName ?? 'Numera Forwarder',
      version: '1',
      chainId: params.chainId,
      verifyingContract: params.forwarder,
    },
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message: request,
  });

  // `nonce` is signed over but is not part of the submitted struct — the forwarder reads the
  // account's current nonce itself, which is what makes a replay impossible rather than merely
  // detectable.
  const { nonce: _nonce, ...submitted } = request;
  return { ...submitted, signature };
}

/**
 * Sign an unlimited approval of the engine, as this market's account.
 *
 * Unlimited rather than per-trade, and deliberately: this account exists to trade one market and
 * holds only what it needs for that, so the standing risk is the float it already has. The
 * alternative is a fresh permit signature bundled with every single trade, which costs a signature
 * round trip and ~5k gas each time, on an account whose exposure is unchanged either way.
 */
export async function signPermit(params: {
  account: PrivateKeyAccount;
  token: `0x${string}`;
  tokenName: string;
  /** From the token itself where possible — see {EIP5267_ABI}. */
  tokenVersion?: string;
  spender: `0x${string}`;
  chainId: number;
  nonce: bigint;
  value?: bigint;
  deadline?: bigint;
}): Promise<PermitSignature> {
  const value = params.value ?? (1n << 256n) - 1n;
  const deadline =
    params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + RELAY_DEADLINE_SECONDS);

  const signature = await params.account.signTypedData({
    domain: {
      name: params.tokenName,
      version: params.tokenVersion ?? PERMIT_VERSION_FALLBACK,
      chainId: params.chainId,
      verifyingContract: params.token,
    },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner: params.account.address,
      spender: params.spender,
      value,
      nonce: params.nonce,
      deadline,
    },
  });

  return {
    owner: params.account.address,
    value,
    deadline,
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    v: parseInt(signature.slice(130, 132), 16),
  };
}

/**
 * Everything needed to sign, read once.
 *
 * Both nonces and the token name come from chain rather than from config, because a stale nonce
 * produces a signature that fails verification with no useful error, and a wrong token name
 * produces a permit that recovers to the wrong address — both of which look like "the relayer is
 * broken" from the outside.
 */
export async function readRelayState(params: {
  rpc: PublicClient;
  forwarder: `0x${string}`;
  token: `0x${string}`;
  /** Whose allowance to read: the engine when trading, the resolver when proposing. */
  spender: `0x${string}`;
  account: `0x${string}`;
}): Promise<{
  forwarderNonce: bigint;
  permitNonce: bigint;
  tokenName: string;
  tokenVersion: string;
  allowance: bigint;
}> {
  const [forwarderNonce, permitNonce, tokenName, allowance] = await Promise.all([
    params.rpc.readContract({
      address: params.forwarder,
      abi: FORWARDER_ABI,
      functionName: 'nonces',
      args: [params.account],
    }),
    params.rpc.readContract({
      address: params.token,
      abi: PERMIT_ABI,
      functionName: 'nonces',
      args: [params.account],
    }),
    params.rpc.readContract({ address: params.token, abi: PERMIT_ABI, functionName: 'name' }),
    params.rpc.readContract({
      address: params.token,
      abi: PERMIT_ABI,
      functionName: 'allowance',
      args: [params.account, params.spender],
    }),
  ]);

  // `version()` first, because that is what real USDC exposes; ERC-5267 second, for tokens that
  // have it. Both are read rather than configured, so a collateral swap cannot silently sign
  // against the wrong domain.
  const declared = await params.rpc
    .readContract({ address: params.token, abi: VERSION_ABI, functionName: 'version' })
    .catch(() => null);

  const domain = declared
    ? null
    : await params.rpc
        .readContract({ address: params.token, abi: EIP5267_ABI, functionName: 'eip712Domain' })
        .catch(() => null);

  return {
    forwarderNonce,
    permitNonce,
    tokenName: domain ? domain[1] : tokenName,
    tokenVersion: declared ?? (domain ? domain[2] : PERMIT_VERSION_FALLBACK),
    allowance,
  };
}

/** Wire format: bigints do not survive JSON, and silently becoming `null` would be worse. */
export interface RelayPayload {
  request: {
    from: string;
    to: string;
    value: string;
    gas: string;
    deadline: number;
    data: string;
    signature: string;
  };
  permit?: { owner: string; value: string; deadline: string; v: number; r: string; s: string };
}

export function toRelayPayload(request: ForwardRequest, permit?: PermitSignature): RelayPayload {
  return {
    request: {
      from: request.from,
      to: request.to,
      value: request.value.toString(),
      gas: request.gas.toString(),
      deadline: request.deadline,
      data: request.data,
      signature: request.signature,
    },
    permit: permit && {
      owner: permit.owner,
      value: permit.value.toString(),
      deadline: permit.deadline.toString(),
      v: permit.v,
      r: permit.r,
      s: permit.s,
    },
  };
}

/** The signing account for a market. Held for one operation and dropped, never cached. */
export function signerFor(root: ExecutionRoot, marketRef: string): PrivateKeyAccount {
  return marketAccount(root, marketRef);
}

/** Re-exported so callers encode against the same ABI the forwarder allowlists. */
export const ENGINE_ABI = parseAbi([
  'function buy(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function buyComplement(uint256 marketId, uint256 outcomeId, uint256 sharesOut, uint256 maxCost) returns (uint256)',
  'function sell(uint256 marketId, uint256 outcomeId, uint256 sharesIn, uint256 minRefund) returns (uint256)',
  'function sellComplement(uint256 marketId, uint256 outcomeId, uint256 sharesIn, uint256 minRefund) returns (uint256)',
  'function redeem(uint256 marketId) returns (uint256)',
]);

export function encodeRelayableCall(
  fn: RelayableFunction,
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: ENGINE_ABI,
    functionName: fn,
    // viem's per-function arg tuples cannot be expressed generically here; the ABI above is the
    // real constraint and a wrong shape fails at encode time, in this call.
    args: args as never,
  });
}
