import { parseAbi } from 'viem';
import { publicClient } from '@/lib/chain/evm';

/**
 * What an execution account already has, before we go and fetch more.
 *
 * Withdrawing from the shielded pool is by far the most expensive thing a trade can do — a ZK
 * proof plus the pool's own bookkeeping, measured at about 2.3 million gas, against roughly
 * 350,000 for the trade itself. Everything here exists to answer one question: can this trade be
 * paid for with what the account is already holding?
 *
 * It very often can. Change from an earlier trade, proceeds from a sale, and the remainder of a
 * deliberate top-up all sit in the account, because returning assets to the pool is disabled
 * while Unlink under-gasses its own deposit-back. Until this check existed we withdrew on every
 * single buy regardless — paying for a proof to fetch money that was already there.
 *
 * Reads go through our own RPC rather than the vendor's API. Asking Unlink "what does this
 * account hold?" would hand their backend the execution account alongside an authenticated
 * session, which is the one link the product exists to break. A public `eth_call` names no user.
 */

const ERC20_READ_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export interface AccountState {
  /** Collateral sitting in the execution account, base units. */
  balance: bigint;
  /** How much of it the market engine may already pull without a fresh approval. */
  allowance: bigint;
}

export interface AccountStateQuery {
  token: string;
  /** The execution account. */
  owner: string;
  /** The market engine. */
  spender: string;
}

/**
 * Read balance and allowance together.
 *
 * Injected into the trading flows rather than imported by them, so the money paths stay free of
 * chain access and remain testable against plain objects.
 */
export type AccountStateReader = (query: AccountStateQuery) => Promise<AccountState>;

/** Both reads in one round trip, and never a reason to fail a trade. */
export const readAccountState: AccountStateReader = async ({ token, owner, spender }) => {
  const rpc = publicClient();
  const common = { address: token as `0x${string}`, abi: ERC20_READ_ABI } as const;

  const [balance, allowance] = await Promise.all([
    rpc.readContract({ ...common, functionName: 'balanceOf', args: [owner as `0x${string}`] }),
    rpc.readContract({
      ...common,
      functionName: 'allowance',
      args: [owner as `0x${string}`, spender as `0x${string}`],
    }),
  ]);

  return { balance, allowance };
};

/**
 * Just the collateral balance of one account.
 *
 * Separate from {@link readAccountState} because the caller that needs it — the scan for
 * collateral stranded in accounts the app has forgotten — has no market and therefore no spender
 * to ask about an allowance for.
 */
export async function readCollateralBalance(query: {
  token: string;
  owner: string;
}): Promise<bigint> {
  return publicClient().readContract({
    address: query.token as `0x${string}`,
    abi: ERC20_READ_ABI,
    functionName: 'balanceOf',
    args: [query.owner as `0x${string}`],
  });
}

/**
 * What a trade must withdraw, and whether it still needs an approval.
 *
 * `funding` lets a trader deliberately draw more than this one trade needs. Doing so is both
 * cheaper and *more private*: a withdrawal of exactly the cost of one fill is visibly the funding
 * leg of that fill, while a round number covering many trades matches nothing in particular.
 * Unlink's own guidance says the same — amount and timing correlation weaken unlinkability.
 *
 * The approval is raised to cover the whole withdrawal rather than this trade alone, so a funded
 * account can keep trading without paying for an `approve` each time. Still bounded: never
 * `type(uint256).max`, which on an account holding a real balance is a standing risk for nothing.
 */
export function planFunding(params: {
  /** Ceiling this trade may spend. */
  maxCost: bigint;
  /** Total the trader wants available in the account afterwards, if more than `maxCost`. */
  funding?: bigint;
  state: AccountState | null;
}): { withdraw: bigint; approve: bigint | null } {
  const { maxCost, funding, state } = params;

  // No reading available: fall back to the old unconditional behaviour. Withdrawing money that
  // was already there wastes gas; failing to withdraw money that was not there fails the trade.
  if (state === null) return { withdraw: maxCost, approve: maxCost };

  const target = funding !== undefined && funding > maxCost ? funding : maxCost;
  const withdraw = target > state.balance ? target - state.balance : 0n;

  // After this operation the account holds at least `target`, so that is what the engine may
  // need to pull across the trades it funds.
  const needed = target;
  const approve = state.allowance >= needed ? null : needed;

  return { withdraw, approve };
}
