import { describe, expect, it, vi } from 'vitest';
import { ApiClient, buildQuery } from './client';
import { ApiError } from './errors';
import { createTokenStore } from './token-store';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(fetchImpl: typeof fetch, onSessionExpired?: () => void) {
  const store = createTokenStore();
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    store,
    fetchImpl,
    onSessionExpired,
  });
  return { client, store };
}

describe('buildQuery', () => {
  it('serializes defined values and drops empty ones', () => {
    expect(buildQuery({ a: 1, b: 'x', c: true })).toBe('?a=1&b=x&c=true');
    expect(buildQuery({ a: undefined, b: null, c: '' })).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });

  it('encodes special characters (regression — search terms)', () => {
    expect(buildQuery({ search: 'a b&c' })).toBe('?search=a+b%26c');
  });
});

describe('ApiClient requests', () => {
  it('performs a GET and returns parsed JSON (positive)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    await expect(client.get('/api/markets')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api.test/api/markets',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends a JSON body with the right content type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    await client.post('/api/auth/nonce', { address: '0x1' });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.body).toBe(JSON.stringify({ address: '0x1' }));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization when auth is not requested (privacy/regression)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const { client, store } = setup(fetchImpl);
    store.setAccess('secret-token');

    await client.get('/api/markets'); // public endpoint
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('attaches the bearer token when auth is requested', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const { client, store } = setup(fetchImpl);
    store.setAccess('abc');

    await client.get('/api/users/me', { auth: true });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer abc');
  });

  it('handles a 204 with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);
    await expect(client.post('/api/auth/logout')).resolves.toBeUndefined();
  });
});

describe('ApiClient error mapping', () => {
  it('maps a validation error body to ApiError with details (negative)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        statusCode: 400,
        error: 'BadRequest',
        message: ['address must be a valid EVM (0x) address'],
      }),
    ) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    const err = (await client.post('/api/auth/nonce', {}).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/valid EVM/);
    expect(err.details).toHaveLength(1);
  });

  it('never leaks internals from a 5xx to the user (negative)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { statusCode: 500, error: 'InternalServerError', message: 'pg: deadlock on users' }),
    ) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    const err = (await client.get('/api/markets').catch((e) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.userMessage).toBe('Something went wrong on our end. Please try again.');
    expect(err.userMessage).not.toMatch(/deadlock/);
  });

  it('wraps a network failure as status 0 (negative)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    const err = (await client.get('/api/markets').catch((e) => e)) as ApiError;
    expect(err.isNetworkError).toBe(true);
    expect(err.userMessage).toMatch(/cannot reach the server/i);
  });

  it('propagates AbortError rather than masking it (regression)', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async () => {
      throw abortErr;
    }) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    await expect(client.get('/api/markets')).rejects.toBe(abortErr);
  });

  it('handles a non-JSON error body without throwing a parse error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    ) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    const err = (await client.get('/api/markets').catch((e) => e)) as ApiError;
    expect(err.status).toBe(502);
  });

  it('maps 429 to a rate-limit message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { statusCode: 429, error: 'TooMany' })) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);
    const err = (await client.get('/api/markets').catch((e) => e)) as ApiError;
    expect(err.isRateLimited).toBe(true);
    expect(err.userMessage).toMatch(/slow down/i);
  });
});

describe('ApiClient token refresh', () => {
  it('refreshes once on 401 and retries the original request (positive)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/api/auth/refresh')) {
        return jsonResponse(200, {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accessExpiresIn: '900s',
          refreshExpiresIn: '30d',
        });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new-access'
        ? jsonResponse(200, { address: '0xabc' })
        : jsonResponse(401, { statusCode: 401, error: 'Unauthorized' });
    }) as unknown as typeof fetch;

    const { client, store } = setup(fetchImpl);
    store.setAccess('stale');
    store.setRefresh('refresh-1');

    await expect(client.get('/api/users/me', { auth: true })).resolves.toEqual({ address: '0xabc' });
    expect(calls.filter((c) => c.endsWith('/api/auth/refresh'))).toHaveLength(1);
    expect(store.getAccess()).toBe('new-access');
    expect(store.getRefresh()).toBe('new-refresh'); // rotated
  });

  it('issues exactly ONE refresh for concurrent 401s (single-flight — critical)', async () => {
    let refreshCount = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/auth/refresh')) {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(200, {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accessExpiresIn: '900s',
          refreshExpiresIn: '30d',
        });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new-access'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { statusCode: 401, error: 'Unauthorized' });
    }) as unknown as typeof fetch;

    const { client, store } = setup(fetchImpl);
    store.setAccess('stale');
    store.setRefresh('refresh-1');

    const results = await Promise.all([
      client.get('/api/a', { auth: true }),
      client.get('/api/b', { auth: true }),
      client.get('/api/c', { auth: true }),
    ]);

    // Rotating refresh tokens mean a second concurrent refresh would present an
    // already-consumed token and get the whole session revoked.
    expect(refreshCount).toBe(1);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  });

  it('clears the session and notifies when refresh fails (negative)', async () => {
    const onSessionExpired = vi.fn();
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/auth/refresh')
        ? jsonResponse(401, { statusCode: 401, error: 'Unauthorized' })
        : jsonResponse(401, { statusCode: 401, error: 'Unauthorized' }),
    ) as unknown as typeof fetch;

    const { client, store } = setup(fetchImpl, onSessionExpired);
    store.setAccess('stale');
    store.setRefresh('bad-refresh');

    await expect(client.get('/api/users/me', { auth: true })).rejects.toBeInstanceOf(ApiError);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(store.getAccess()).toBeNull();
    expect(store.getRefresh()).toBeNull();
  });

  it('does not attempt refresh when there is no refresh token (negative)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { statusCode: 401, error: 'Unauthorized' }),
    ) as unknown as typeof fetch;
    const { client } = setup(fetchImpl);

    await expect(client.get('/api/users/me', { auth: true })).rejects.toBeInstanceOf(ApiError);
    const refreshCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).endsWith('/api/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it('refreshes before the first call on a cold load rather than eating a 401 (regression)', async () => {
    // The access token lives in memory and the refresh token is persisted, so every cold page
    // load of a signed-in browser has exactly one of the two. Sending the request anyway meant a
    // guaranteed 401 → refresh → retry: it worked, and it printed a red `401 /api/users/me` in
    // the console on every single load, which reads as something being broken.
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/api/auth/refresh')
        ? jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2' })
        : jsonResponse(200, { id: 'u1' }),
    ) as unknown as typeof fetch;
    const { client, store } = setup(fetchImpl);
    store.setRefresh('refresh-1'); // ...and deliberately NO access token, as after a reload.

    await expect(client.get('/api/users/me', { auth: true })).resolves.toEqual({ id: 'u1' });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Refresh first, then the request — two round trips, and never a 401.
    expect(calls.map((c) => String(c[0]).replace('http://api.test', ''))).toEqual([
      '/api/auth/refresh',
      '/api/users/me',
    ]);
    expect((calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-2',
    });
  });

  it('issues ONE refresh for concurrent cold-load requests (single-flight — critical)', async () => {
    // Refresh tokens rotate, so two refreshes on boot means the second presents an already-spent
    // token and the backend revokes the session as suspected reuse. A page fires several
    // authenticated queries at once, so this is the ordinary path, not an edge case.
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/api/auth/refresh')
        ? jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2' })
        : jsonResponse(200, { ok: true }),
    ) as unknown as typeof fetch;
    const { client, store } = setup(fetchImpl);
    store.setRefresh('refresh-1');

    await Promise.all([
      client.get('/api/users/me', { auth: true }),
      client.get('/api/positions', { auth: true }),
      client.get('/api/admin/me', { auth: true }),
    ]);

    const refreshCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).endsWith('/api/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it('signs the user out when the stored refresh token is already dead (negative)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { statusCode: 401, error: 'Unauthorized' }),
    ) as unknown as typeof fetch;
    const onSessionExpired = vi.fn();
    const { client, store } = setup(fetchImpl, onSessionExpired);
    store.setRefresh('expired');

    await expect(client.get('/api/users/me', { auth: true })).rejects.toBeInstanceOf(ApiError);
    expect(store.getRefresh()).toBeNull();
    // Told once, not twice: the pre-flight refresh clears the token, so the 401 branch must not
    // announce the same expiry a second time.
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on 401 for a public request (regression)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { statusCode: 401, error: 'Unauthorized' }),
    ) as unknown as typeof fetch;
    const { client, store } = setup(fetchImpl);
    store.setRefresh('refresh-1');

    await expect(client.get('/api/markets')).rejects.toBeInstanceOf(ApiError);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
