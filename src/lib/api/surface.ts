import type {
  AdminRoles,
  AuthUser,
  Candle,
  Category,
  ListMarketsParams,
  Market,
  NonceResponse,
  OperationsQueue,
  Paginated,
  PoolShieldBody,
  PoolState,
  PoolWithdrawBody,
  Position,
  RelayGauge,
  RelayState,
  ResolutionTerms,
  Sparkline,
  Trade,
  UnlinkEnvironment,
  VerifyResponse,
} from './types';

/**
 * The complete set of backend calls this app makes.
 *
 * Two implementations satisfy it: the real HTTP client, and the static dataset
 * used for design review (`lib/mock`). Declaring the contract once means the
 * compiler catches any drift between them — a mock that silently stops matching
 * the API would make the UI look correct while being wrong.
 */
export interface ApiSurface {
  auth: {
    nonce(address: string): Promise<NonceResponse>;
    verify(message: string, signature: string): Promise<VerifyResponse>;
    logout(refreshToken: string): Promise<void>;
  };

  markets: {
    list(params?: ListMarketsParams, signal?: AbortSignal): Promise<Paginated<Market>>;
    byId(id: string, signal?: AbortSignal): Promise<Market>;
    categories(signal?: AbortSignal): Promise<Category[]>;
    resolutionTerms(id: string, signal?: AbortSignal): Promise<ResolutionTerms>;
  };

  trades: {
    byMarket(
      marketRef: string,
      limit?: number,
      offset?: number,
      signal?: AbortSignal,
    ): Promise<Paginated<Trade>>;
  };

  prices: {
    candles(
      marketRef: string,
      params: { interval?: string; outcome?: number; from?: string; to?: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<Candle[]>;
    latest(
      marketRef: string,
      signal?: AbortSignal,
    ): Promise<{ outcomeIndex: number; priceWad: string }[]>;
    /**
     * Recent shape for a whole page of markets, in one request.
     *
     * Batched on purpose: the board draws every market as a card, and asking per card is an
     * N+1 paid on the first screen anyone sees. Markets that have never traded are absent from
     * the response rather than present-and-empty.
     */
    sparklines(
      markets: string[],
      params: { outcome?: number; hours?: number },
      signal?: AbortSignal,
    ): Promise<Sparkline[]>;
  };

  positions: {
    /**
     * Portfolio for execution accounts the CLIENT knows it owns. The server can
     * never derive this from the login identity — that link does not exist.
     */
    forAccounts(accounts: string[], signal?: AbortSignal): Promise<Position[]>;
  };

  users: {
    me(signal?: AbortSignal): Promise<AuthUser>;
  };

  /**
   * Operator surface. Every route is gated on ON-CHAIN roles, never a database
   * flag — and there is deliberately no `resolve` here: the server holds no
   * resolver key, so settlement is signed by the operator's own wallet.
   */
  admin: {
    /** Roles the signed-in wallet holds. `isOperator: false` hides the console. */
    me(signal?: AbortSignal): Promise<AdminRoles>;
    /** Markets past close with no settlement, plus the signer quorum that settles them. */
    operations(signal?: AbortSignal): Promise<OperationsQueue>;
    /** The gas relayer's figures. Role-gated: only these wallets can act on them. */
    relay(signal?: AbortSignal): Promise<RelayGauge>;
  };

  /**
   * Sponsored execution, which is what makes a bet gasless.
   *
   * One public route, and it answers with a state rather than a gauge. See {@link RelayState}.
   */
  relay: {
    status(signal?: AbortSignal): Promise<RelayState>;
  };

  /**
   * Numera's shielded pool.
   *
   * All three routes are unauthenticated, and that is the design rather than an omission: a session
   * attached to any of them would let the backend's own logs record which signed-in user funded
   * which market account — the exact link the pool exists to destroy. The proof and the signature
   * are the authorisation, and both name their own destination.
   */
  pool: {
    /** The state tree and both roots, for building a withdrawal proof in the browser. */
    state(signal?: AbortSignal): Promise<PoolState>;
    /** Submit a proof. The relayer pays; the recipient is sealed inside the proof. */
    withdraw(body: PoolWithdrawBody, signal?: AbortSignal): Promise<{ hash: string }>;
    /** Return a gasless account's balance to the pool, authorised by its own signature. */
    shield(body: PoolShieldBody, signal?: AbortSignal): Promise<{ hash: string }>;
  };

  /**
   * The privacy layer's control plane. The admin API key lives only on our
   * backend, so the browser registers and mints authorization tokens through
   * here rather than talking to Engine's privileged endpoints directly.
   */
  unlink: {
    /** Whether this deployment has a privacy layer, and which Engine to bind to. */
    environment(signal?: AbortSignal): Promise<UnlinkEnvironment>;
    /** Idempotently register the caller's Unlink keys and bind them to this login. */
    register(payload: unknown, signal?: AbortSignal): Promise<{ address: string }>;
    /** Short-lived (≤900s) Engine credential for the caller's own Unlink address. */
    authorizationToken(
      unlinkAddress: string,
      signal?: AbortSignal,
    ): Promise<{ token: string; expiresAt: string }>;
  };
}
