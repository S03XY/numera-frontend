/**
 * Local registry of the execution accounts this client owns.
 *
 * PRIVACY-CRITICAL: the server has no way to know which shielded execution
 * accounts belong to which login — that link is exactly what the product hides.
 * So the client must remember its own accounts to assemble a portfolio and to
 * reuse the right account when claiming.
 *
 * This is deliberately LOCAL ONLY. It must never be sent to a server as part of
 * a profile or account record; it is passed transiently to
 * `POST /positions/query`, which returns public on-chain data and stores nothing.
 *
 * Losing this list is not fatal — positions remain recoverable from the user's
 * Unlink account — but recovery requires the wallet, not our backend.
 */

const KEY = 'numera.executionAccounts';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Observable so React can read this with `useSyncExternalStore`.
 *
 * Placing a bet mints a fresh account and registers it here; without a
 * notification the Portfolio screen would keep rendering the old list until the
 * next full remount, and the position the user just opened would appear to be
 * missing.
 */
const listeners = new Set<() => void>();
let snapshot: string[] | null = null;

export function subscribeToExecutionAccounts(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function invalidate(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/**
 * Cached so repeated calls return the SAME array reference —
 * `useSyncExternalStore` compares snapshots by identity and would otherwise
 * re-render forever.
 */
export function getExecutionAccountsSnapshot(): string[] {
  if (snapshot === null) snapshot = getExecutionAccounts();
  return snapshot;
}

const EMPTY: string[] = [];

/** The server has no list — the whole point is that it cannot have one. */
export function getServerExecutionAccountsSnapshot(): string[] {
  return EMPTY;
}

export function getExecutionAccounts(): string[] {
  const raw = storage()?.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a))
      .map((a) => a.toLowerCase());
  } catch {
    return [];
  }
}

/** Add an account. Idempotent, normalized, rejects malformed addresses. */
export function addExecutionAccount(address: string): string[] {
  if (!ADDRESS_RE.test(address)) return getExecutionAccounts();
  const next = Array.from(new Set([...getExecutionAccounts(), address.toLowerCase()]));
  storage()?.setItem(KEY, JSON.stringify(next));
  invalidate();
  return next;
}

export function removeExecutionAccount(address: string): string[] {
  const next = getExecutionAccounts().filter((a) => a !== address.toLowerCase());
  storage()?.setItem(KEY, JSON.stringify(next));
  invalidate();
  return next;
}

export function clearExecutionAccounts(): void {
  storage()?.removeItem(KEY);
  invalidate();
}
