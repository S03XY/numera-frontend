/**
 * API contract types, mirroring the backend response shapes.
 *
 * All on-chain integers arrive as DECIMAL STRINGS (uint256 exceeds Number.
 * MAX_SAFE_INTEGER). Parse with BigInt — never Number — see lib/format.ts.
 */

/**
 * Pricing engine. One, deliberately: a parimutuel pool cannot let a trader exit before
 * settlement, and the fixed-`b` LMSR needed a protocol-funded subsidy the damped curve removes.
 */
export type Engine = 'LS_LMSR';
export type MarketStatus = 'TRADING' | 'RESOLVED' | 'INVALID';
/** `SHORT` is `buyComplement`: one share of every OTHER outcome, paying 1 iff this one loses. */
export type TradeSide = 'BUY' | 'SELL' | 'SHORT';

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Outcome {
  index: number;
  label: string;
  priceWad: string | null;
  /** Same value as priceWad, expressed as a 0–1 decimal string. */
  probability: string | null;
  shares: string | null;
}

export interface Market {
  id: string;
  engine: Engine;
  address: string;
  marketId: string;
  title: string;
  description: string;
  imageUrl: string | null;
  category: string | null;
  status: MarketStatus;
  tradingOpen: boolean;
  /**
   * How this market settles, published at creation.
   *
   * Not editable copy: it is inside the `metadataHash` the engine stores immutably, so anyone can
   * re-encode what the API serves, hash it, and check it against the chain. That is what makes it
   * a commitment rather than a claim — and in a market where anyone may propose the result, it is
   * the rule book everybody has to be reading from.
   *
   * Empty only for markets created before rules existed.
   */
  resolutionRules: string;
  /**
   * When betting opens, enforced on chain.
   *
   * Always present: the engine substitutes the creation timestamp when a creator does not name one,
   * so a market that opened immediately reports a start time in the past rather than null. Compare
   * it; do not check for absence.
   */
  startTime: string;
  /** True while the clock is before {@link startTime}. A bet now reverts with `MarketNotOpenYet`. */
  notOpenYet: boolean;
  closeTime: string;
  winningOutcomeId: number | null;
  collateral: string;
  collateralDecimals: number;
  /** Liquidity coefficient (WAD), immutable on-chain. */
  alpha: string | null;
  /** Damping scale (WAD), immutable on-chain. Deepens thin books, fades as the book grows. */
  sStar: string | null;
  /** Shares of every outcome the creator seeded, locked until resolution. */
  seed: string | null;
  /** Collateral the market holds. Always at least the largest possible payout. */
  pot: string;
  potHuman: string | null;
  /** Swept to the fee recipient at settlement; null until then. */
  surplus: string | null;
  outcomeCount: number;
  outcomes: Outcome[];
  /** Null while the market has never been through the resolution layer, which is most of its life. */
  resolution: Resolution | null;
  createdAt: string;
}

export type ResolutionPhase = 'NONE' | 'PROPOSED' | 'DISPUTED' | 'SETTLED';
export type ResolutionRoute = 'FINALIZED' | 'ARBITRATED';

/**
 * Where a market's settlement has got to.
 *
 * `proposer`, `disputer` and `loser` are market execution accounts — the same shielded addresses
 * that appear on trades, never login wallets. They are already public on chain, and showing them is
 * what lets a trader check the record instead of taking our word for it.
 *
 * Every amount here is historical: what was actually staked and paid. What it would cost to take
 * part *now* moves with the book and comes from {@link ResolutionTerms}.
 */
export interface Resolution {
  phase: ResolutionPhase;
  /** The standing assertion, or null when it is "void this market". */
  proposedOutcome: number | null;
  proposer: string | null;
  /** False for an operator's bond-free proposal: nothing staked, so nothing to forfeit. */
  bonded: boolean;
  bond: string | null;
  disputeDeadline: string | null;
  /** Whether the window is open right now. Computed server-side against one clock. */
  disputable: boolean;
  /** Whether anyone may settle it now. Not the same as the window having passed. */
  finalizable: boolean;
  disputer: string | null;
  counterOutcome: number | null;
  disputerBond: string | null;
  arbitrationDeadline: string | null;
  route: ResolutionRoute | null;
  settledOutcome: number | null;
  reward: string | null;
  forfeited: string | null;
  /** The account that staked on a false outcome, lost it, and was barred from trading. */
  loser: string | null;
  settledAt: string | null;
}

/**
 * What taking part costs right now, read live from the resolver.
 *
 * Its own request rather than a field on the market, because the reward tracks the fees that market
 * has earned and moves with every trade — a cached figure would be a price we cannot honour.
 *
 * `available: false` means the resolver is not configured or unreachable. The market still settles;
 * the UI should say the operator handles it rather than show an error.
 */
export type ResolutionTerms =
  | { available: false }
  | {
      available: true;
      resolver: string;
      bond: string;
      bondHuman: string | null;
      fee: string;
      feeHuman: string | null;
      reward: string;
      rewardHuman: string | null;
      disputeWindowSeconds: number;
      rewardPool: string;
      rewardPoolHuman: string | null;
    };

export interface Category {
  key: string;
  label: string;
  enabled: boolean;
}

export interface Trade {
  id: string;
  marketRef: string;
  engine: Engine;
  side: TradeSide;
  /** Pseudonymous execution account — NOT a user. Render via <ShieldedAccount>. */
  account: string;
  outcomeIndex: number;
  shares: string;
  amount: string;
  /** Spread applied to this trade (WAD). Already included in `amount`. */
  spreadWad: string;
  priceWad: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
}

export interface Position {
  marketRef: string;
  marketTitle: string;
  marketStatus: MarketStatus;
  engine: Engine;
  /** Engine contract address — the target of the claim call. */
  marketAddress: string;
  /** The engine's own market id (uint256 as a decimal string). */
  marketOnChainId: string;
  /** Collateral token, swept back into the shielded pool when claiming. */
  collateral: string;
  account: string;
  outcomeIndex: number;
  outcomeLabel: string;
  shares: string;
  costBasis: string;
  realizedPnl: string;
  redeemed: boolean;
  currentPriceWad: string | null;
  winningOutcomeId: number | null;
  markToMarket: string | null;
}

/**
 * One market's recent price shape, for a card-sized line.
 *
 * Closes only — a sparkline has no room for a high/low, and sending OHLC for a whole board would
 * be four times the bytes for detail no one can see at that size.
 */
export interface Sparkline {
  marketRef: string;
  /** Bucketed closing prices, WAD, oldest first. */
  points: string[];
}

export interface Candle {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface AuthUser {
  id: string;
  address: string;
  displayName: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

export interface VerifyResponse {
  isNewUser: boolean;
  user: AuthUser;
  tokens: AuthTokens;
}

export interface NonceResponse {
  message: string;
  nonce: string;
  expiresAt: string;
}

/** Error envelope produced by the backend's global exception filter. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

export interface ListMarketsParams {
  status?: MarketStatus;
  engine?: Engine;
  category?: string;
  search?: string;
  openOnly?: boolean;
  sort?: 'closeTime' | 'createdAt' | 'pot';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * Whether this deployment has a working privacy layer, and how to reach it.
 *
 * A discriminated union rather than an optional-fields object: "Unlink is off"
 * is a normal, renderable state (the wallet screen explains it), and the type
 * should make it impossible to read `poolAddress` without first proving it is on.
 */
export type UnlinkEnvironment =
  | { enabled: false }
  | {
      enabled: true;
      /** Hosted environment name to bind the browser client to, e.g. `monad-testnet`. */
      environment: string;
      chainId: number;
      poolAddress: string;
      permit2Address: string;
      /** False would mean private trading is impossible even though Unlink is up. */
      executionAccountsEnabled: boolean;
    };

/** On-chain roles held by the signed-in wallet. Drives whether admin nav appears. */
export interface AdminRoles {
  address: string;
  roles: string[];
  isOperator: boolean;
}

/**
 * Whether a sponsored action can be attempted right now. A state, never a gauge.
 *
 * Numera pays the network fee on every bet, so a relayer that is out of budget stops betting for
 * everybody. What the public endpoint answers with is deliberately thin: no address, no balance,
 * no spend against the cap. A trader can act on "paused" and can act on nothing else, and the
 * figures published beside a daily cap would tell whoever is draining us how close they are.
 */
export interface RelayState {
  /** May a bet be placed? False only for the refusals the backend actually enforces. */
  available: boolean;
  /** `capped` is today's gas budget, spent. `disabled` means no relayer on this deployment. */
  reason: 'disabled' | 'capped' | null;
  /** Whether sponsored proposals and disputes are wired up too. */
  resolution: boolean;
}

/** The figures behind {@link RelayState}, for the wallets that can act on them. */
export interface RelayGauge {
  enabled: boolean;
  relayer: string | null;
  /** Null when the RPC could not answer. Not the same as an empty relayer. */
  balanceWei: string | null;
  spentTodayWei: string;
  dailyCapWei: string;
  minBalanceWei: string;
  lowBalance: boolean;
  resolution: boolean;
}

/**
 * One leaf of the shielded pool's state tree.
 *
 * Every field is already public on chain — there is no owner here and there cannot be one. A client
 * finds its own notes by recomputing precommitments from a secret it never sends anywhere; see
 * `lib/pool/notes.ts`.
 */
export interface PoolLeafView {
  /** Position in the state tree. Load-bearing: the Merkle path is built from it. */
  index: number;
  kind: 'DEPOSIT' | 'CHANGE';
  commitment: string;
  /** Deposits only. A change note inherits its parent's lineage and enters no association set. */
  label: string | null;
  value: string;
  /** Deposits only. `Poseidon(nullifier, secret)`. */
  precommitment: string | null;
  /** Change only. `Poseidon(nullifier)` of the note that was spent. */
  spentNullifier: string | null;
}

/** Everything the browser needs to build a withdrawal proof, in one read. */
export interface PoolState {
  enabled: boolean;
  chainId: number;
  entrypoint: string;
  privacyPool: string;
  asset: string;
  scope: string;
  /** The pool's own root. A client that rebuilds the tree and disagrees must not prove. */
  stateRoot: string;
  onChainAspRoot: string;
  aspRoot: string;
  /** False while the backend's mirror is still catching up, in which case the tree is short. */
  synced: boolean;
  leaves: PoolLeafView[];
}

export interface PoolWithdrawBody {
  withdrawal: { processooor: string; data: string };
  proof: {
    pA: string[];
    pB: string[][];
    pC: string[];
    pubSignals: string[];
  };
}

export interface PoolShieldBody {
  request: { owner: string; value: string; precommitment: string; deadline: string };
  /** The owner's EIP-712 `Shield` signature. Names the note, so no submitter can redirect it. */
  signature: string;
  /** Omitted when the allowance already exists. */
  permit?: { deadline: string; v: number; r: string; s: string };
}

/** A market past its close time with no settlement yet. */
export interface AwaitingResolution {
  id: string;
  title: string;
  engine: Engine;
  address: string;
  marketId: string;
  closeTime: string;
  /** The resolver the market is bound to. Immutable from the moment it was created. */
  resolver: string;
  outcomeCount: number;
  pot: string;
}

/**
 * A market with a live proposal on it, either disputed or ready to settle.
 *
 * `id` is nullable because a proposal can be indexed before the market it is about — resolution and
 * trading are separate contracts on separate streams. Such a row is still shown, because a disputed
 * market the operator cannot see is worse than one with a missing title.
 */
export interface LiveResolution extends Partial<AwaitingResolution> {
  address: string;
  marketId: string;
  title: string;
  phase: ResolutionPhase;
  proposer: string | null;
  proposedOutcome: number | null;
  /** False for an operator's own bond-free proposal. */
  proposerBonded: boolean;
  proposerBond: string | null;
  disputer: string | null;
  counterOutcome: number | null;
  disputerBond: string | null;
  disputeDeadline: string | null;
  /** After this, anyone may unwind the dispute and return both stakes without settling anything. */
  arbitrationDeadline: string | null;
}

/**
 * The three shapes operator attention actually arrives in.
 *
 * They are separate jobs, not one list with a status column: only the quorum can clear a dispute,
 * anyone at all can clear a finalizable proposal, and an unproposed market is waiting on nobody in
 * particular and so gets forgotten unless it is listed on its own.
 */
export interface OperationsQueue {
  awaitingProposal: AwaitingResolution[];
  disputed: LiveResolution[];
  finalizable: LiveResolution[];
  counts: { awaitingProposal: number; disputed: number; finalizable: number };
}
