import { api } from './client';
import type { ApiSurface } from './surface';
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

/** Every backend call the app makes, in one typed surface. */
const httpEndpoints: ApiSurface = {
  auth: {
    nonce: (address: string) => api.post<NonceResponse>('/api/auth/nonce', { address }),
    verify: (message: string, signature: string) =>
      api.post<VerifyResponse>('/api/auth/verify', { message, signature }),
    logout: (refreshToken: string) => api.post<void>('/api/auth/logout', { refreshToken }),
  },

  markets: {
    list: (params: ListMarketsParams = {}, signal?: AbortSignal) =>
      api.get<Paginated<Market>>('/api/markets', {
        query: { ...params },
        signal,
      }),
    byId: (id: string, signal?: AbortSignal) => api.get<Market>(`/api/markets/${id}`, { signal }),
    categories: (signal?: AbortSignal) => api.get<Category[]>('/api/categories', { signal }),
    /** Live cost of proposing or disputing. Read on demand — see {@link ResolutionTerms}. */
    resolutionTerms: (id: string, signal?: AbortSignal) =>
      api.get<ResolutionTerms>(`/api/markets/${id}/resolution/terms`, { signal }),
  },

  trades: {
    byMarket: (marketRef: string, limit = 50, offset = 0, signal?: AbortSignal) =>
      api.get<Paginated<Trade>>(`/api/markets/${marketRef}/trades`, {
        query: { limit, offset },
        signal,
      }),
  },

  prices: {
    candles: (
      marketRef: string,
      params: { interval?: string; outcome?: number; from?: string; to?: string; limit?: number },
      signal?: AbortSignal,
    ) => api.get<Candle[]>(`/api/markets/${marketRef}/prices/candles`, { query: params, signal }),
    latest: (marketRef: string, signal?: AbortSignal) =>
      api.get<{ outcomeIndex: number; priceWad: string }[]>(
        `/api/markets/${marketRef}/prices/latest`,
        { signal },
      ),
    sparklines: (
      markets: string[],
      params: { outcome?: number; hours?: number } = {},
      signal?: AbortSignal,
    ) =>
      api.get<Sparkline[]>('/api/prices/sparklines', {
        query: { markets: markets.join(','), ...params },
        signal,
      }),
  },

  positions: {
    /**
     * Portfolio for execution accounts the CLIENT knows it owns. The server can
     * never derive this from the login identity — that link does not exist.
     */
    forAccounts: (accounts: string[], signal?: AbortSignal) =>
      api.post<Position[]>('/api/positions/query', { accounts }, { signal }),
  },

  users: {
    me: (signal?: AbortSignal) => api.get<AuthUser>('/api/users/me', { auth: true, signal }),
  },

  admin: {
    // Both authenticated: the backend re-checks on-chain roles per request, so a
    // client that lies about being an operator simply gets a 403.
    me: (signal?: AbortSignal) => api.get<AdminRoles>('/api/admin/me', { auth: true, signal }),
    operations: (signal?: AbortSignal) =>
      api.get<OperationsQueue>('/api/admin/operations', { auth: true, signal }),
    relay: (signal?: AbortSignal) => api.get<RelayGauge>('/api/admin/relay', { auth: true, signal }),
  },

  relay: {
    // Public, and thin on purpose: whether a bet can be placed, and nothing a trader cannot act
    // on. The figures live behind `admin.relay`.
    status: (signal?: AbortSignal) => api.get<RelayState>('/api/relay/status', { signal }),
  },

  pool: {
    state: (signal?: AbortSignal) => api.get<PoolState>('/api/pool/state', { signal }),
    // No `auth: true` on either write, deliberately. See the doc on `ApiSurface['pool']`.
    withdraw: (body: PoolWithdrawBody, signal?: AbortSignal) =>
      api.post<{ hash: string }>('/api/pool/withdraw', body, { signal }),
    shield: (body: PoolShieldBody, signal?: AbortSignal) =>
      api.post<{ hash: string }>('/api/pool/shield', body, { signal }),
  },

  unlink: {
    // Public: the wallet screen has to be able to say "private trading is off here"
    // before the user signs in.
    environment: (signal?: AbortSignal) =>
      api.get<UnlinkEnvironment>('/api/unlink/environment', { signal }),

    // Authenticated: both of these act on the caller's own identity, and the
    // token endpoint hands out a credential scoped to their shielded address.
    register: (payload: unknown, signal?: AbortSignal) =>
      api.post<{ address: string }>('/api/unlink/register', { payload }, { auth: true, signal }),

    authorizationToken: (unlinkAddress: string, signal?: AbortSignal) =>
      api.post<{ token: string; expiresAt: string }>(
        '/api/unlink/authorization-token',
        { unlinkAddress },
        { auth: true, signal },
      ),
  },
};

/**
 * The API the app talks to.
 *
 * In design-preview mode this is the in-memory dataset; otherwise it is the
 * real HTTP client. Both satisfy `ApiSurface`, so no caller — hook, component
 * or test — needs to know which one it got.
 */
/**
 * The only API surface.
 *
 * There used to be a design-preview implementation behind an env flag that served an in-memory
 * dataset. It is gone: a fabricated market is indistinguishable from a real one once it reaches a
 * component, so anyone browsing a preview build could see — and try to trade — a market that does
 * not exist. Everything rendered now comes from the indexer reading the chain.
 */
export const endpoints: ApiSurface = httpEndpoints;
