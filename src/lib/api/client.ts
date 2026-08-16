import { ApiError, apiErrorFromBody } from './errors';
import { tokenStore, type TokenStore } from './token-store';
import type { AuthTokens } from './types';

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Attach the bearer token and refresh-and-retry once on 401. */
  auth?: boolean;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

export interface ApiClientConfig {
  baseUrl?: string;
  store?: TokenStore;
  fetchImpl?: typeof fetch;
  /** Called when the session is unrecoverable, so the UI can send the user to sign in. */
  onSessionExpired?: () => void;
}

export function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly store: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onSessionExpired?: () => void;

  /**
   * In-flight refresh shared by all callers. Without this, N concurrent 401s
   * would fire N refreshes; since refresh tokens ROTATE, the later ones would
   * present an already-consumed token and the backend would revoke the whole
   * session as suspected reuse. Single-flight is a correctness requirement.
   */
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? API_BASE).replace(/\/$/, '');
    this.store = config.store ?? tokenStore;
    this.fetchImpl = config.fetchImpl ?? ((...a) => fetch(...a));
    this.onSessionExpired = config.onSessionExpired;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { auth = false } = options;

    /*
      Refresh BEFORE the first call when we already know it cannot succeed.

      The access token lives in memory only and the refresh token is persisted, so every cold page
      load of a signed-in browser starts with exactly one of the two. Sending the request anyway
      meant a guaranteed 401, a refresh, and a retry — the flow worked, but it announced itself as
      a red `401 /api/users/me` in the console on every single load, which is indistinguishable
      from something being broken to anyone reading it.

      Cheaper as well as quieter: two round trips on boot instead of three. `refreshAccessToken` is
      already single-flight, so the several authenticated queries a page fires at once still share
      one refresh rather than racing to rotate the token.
    */
    let token = auth ? this.store.getAccess() : null;
    if (auth && token === null && this.store.getRefresh() !== null) {
      token = await this.refreshAccessToken();
      if (token === null) {
        // The stored refresh token is dead. Drop it now, so the 401 branch below does not fire a
        // second pointless refresh, and the UI is told once.
        this.store.clear();
        this.onSessionExpired?.();
      }
    }

    let response = await this.send(path, options, token);

    // Still needed: a token that was live when the request left and expired before it arrived, or
    // one revoked server-side mid-session. Neither is predictable from here.
    if (response.status === 401 && auth) {
      const fresh = await this.refreshAccessToken();
      if (fresh) {
        response = await this.send(path, options, fresh);
      } else if (this.store.getRefresh() !== null) {
        this.store.clear();
        this.onSessionExpired?.();
      }
    }

    return this.parse<T>(response);
  }

  private async send(
    path: string,
    options: RequestOptions,
    accessToken: string | null,
  ): Promise<Response> {
    const { method = 'GET', body, query, signal } = options;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}${buildQuery(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ApiError(0, 'NetworkError', (err as Error)?.message ?? 'Network request failed');
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    let payload: unknown = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) throw apiErrorFromBody(response.status, payload);
    return payload as T;
  }

  /** Exchange the stored refresh token for a new pair. Shared across callers. */
  private refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshToken = this.store.getRefresh();
    if (!refreshToken) return Promise.resolve(null);

    this.refreshInFlight = (async () => {
      try {
        const res = await this.send(
          '/api/auth/refresh',
          { method: 'POST', body: { refreshToken } },
          null,
        );
        if (!res.ok) return null;
        const tokens = (await res.json()) as AuthTokens;
        this.store.setAccess(tokens.accessToken);
        this.store.setRefresh(tokens.refreshToken);
        return tokens.accessToken;
      } catch {
        return null;
      } finally {
        // Cleared in a microtask so concurrent callers all observe this attempt.
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }
  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }
  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }
}

export const api = new ApiClient();
