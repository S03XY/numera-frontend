/**
 * Session token storage.
 *
 * The access token is kept in memory only (never persisted), so an XSS-readable
 * store never holds a live bearer credential for long. The refresh token is
 * persisted so a returning user is signed in without a new wallet signature —
 * that is the whole point of the "sign once" flow.
 */

const REFRESH_KEY = 'synthatic.refreshToken';

export interface TokenStore {
  getAccess(): string | null;
  setAccess(token: string | null): void;
  getRefresh(): string | null;
  setRefresh(token: string | null): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // private-mode / blocked storage
  }
}

export function createTokenStore(): TokenStore {
  let access: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    getAccess: () => access,
    setAccess(token) {
      access = token;
      notify();
    },
    getRefresh() {
      return safeStorage()?.getItem(REFRESH_KEY) ?? null;
    },
    setRefresh(token) {
      const s = safeStorage();
      if (!s) return;
      if (token) s.setItem(REFRESH_KEY, token);
      else s.removeItem(REFRESH_KEY);
      notify();
    },
    clear() {
      access = null;
      safeStorage()?.removeItem(REFRESH_KEY);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const tokenStore = createTokenStore();
