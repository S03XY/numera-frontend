import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Privacy invariants of the HTTP surface, pinned as tests.
 *
 * These are not style preferences — they are the difference between the server
 * being able to link a login identity to a set of execution accounts and not.
 * Adding `auth: true` to the wrong endpoint is a one-word change that silently
 * breaks the product's core claim, so it gets a test rather than a comment.
 */

vi.mock('./config', () => ({}));

const ORIGINAL_FETCH = globalThis.fetch;

/** Captures the headers of every request the endpoint layer issues. */
function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('portfolio query privacy', () => {
  it('never attaches the bearer token to POST /positions/query', async () => {
    const { tokenStore } = await import('./token-store');
    const { endpoints } = await import('./endpoints');

    // A fully logged-in client is the dangerous case: the token exists and is
    // one option away from being sent.
    tokenStore.setAccess('access-token-value');

    const calls = captureFetch();
    await endpoints.positions.forAccounts([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/positions/query');
    // The whole privacy model rests on this: the server sees a set of addresses
    // with no session attached, so it cannot tie them to a person.
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('still authenticates endpoints that are genuinely about the user (regression)', async () => {
    const { tokenStore } = await import('./token-store');
    const { endpoints } = await import('./endpoints');

    tokenStore.setAccess('access-token-value');
    const calls = captureFetch();
    await endpoints.users.me();

    // /users/me is *supposed* to be authenticated — the invariant above must not
    // have been achieved by breaking auth everywhere.
    expect(calls[0].headers.authorization).toBe('Bearer access-token-value');
  });
});
