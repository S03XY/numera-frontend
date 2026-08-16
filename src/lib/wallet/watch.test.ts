import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./injected', () => ({ findInjectedWallet: vi.fn() }));

const { findInjectedWallet } = await import('./injected');
const { rememberWallet } = await import('./reconnect');
const { sameAddress, watchWalletAccount } = await import('./watch');

const findWallet = findInjectedWallet as unknown as ReturnType<typeof vi.fn>;

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

/** A stand-in extension, with the two EIP-1193 pieces this file touches. */
function provider(accounts: string[] = [A]) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    listeners,
    // Throws on anything unhandled rather than resolving null. A permissive stub absorbs exactly
    // the mistake this file exists to prevent: a prompting call added to `watch.ts` would resolve
    // to null, the watcher would carry on, and the suite would stay green while every page load
    // opened MetaMask.
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_accounts') {
        throw Object.assign(new Error(`Unhandled ${method}`), { code: -32601 });
      }
      return accounts;
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
    /** Fire the wallet's own event, the way switching accounts in MetaMask does. */
    switchTo(...next: string[]) {
      listeners.get('accountsChanged')?.(next);
    },
  };
}

/** The watcher resolves the wallet asynchronously; let that settle before asserting. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('watchWalletAccount', () => {
  it('reports the account the wallet is already on (positive)', async () => {
    findWallet.mockResolvedValue({ rdns: 'io.metamask', provider: provider([A]) });
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    const seen = vi.fn();

    watchWalletAccount(seen);
    await settled();

    expect(seen).toHaveBeenCalledWith(A);
  });

  it('never prompts: no eth_requestAccounts and no permission request (regression)', async () => {
    const p = provider([A]);
    findWallet.mockResolvedValue({ rdns: 'io.metamask', provider: p });
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });

    watchWalletAccount(vi.fn());
    await settled();

    // This runs unprompted on every page load for a signed-in user. The requesting form opens
    // MetaMask's approval dialog, and a site that does that by itself on load is one people stop
    // trusting.
    const methods = p.request.mock.calls.map((c) => (c[0] as { method: string }).method);
    expect(methods).toContain('eth_accounts');
    expect(methods).not.toContain('eth_requestAccounts');
    // The permission request opens the same dialog, and is the more tempting mistake now that it
    // exists: it is the method that makes a switched account visible, so reaching for it here
    // looks like a fix rather than an unprompted popup on every page load.
    expect(methods).not.toContain('wallet_requestPermissions');
  });

  it('follows a switch in the extension (positive)', async () => {
    const p = provider([A]);
    findWallet.mockResolvedValue({ rdns: 'io.metamask', provider: p });
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    const seen = vi.fn();

    watchWalletAccount(seen);
    await settled();
    p.switchTo(B);

    expect(seen).toHaveBeenLastCalledWith(B);
  });

  it('reports a wallet that disconnected the site as no account (negative)', async () => {
    const p = provider([A]);
    findWallet.mockResolvedValue({ rdns: 'io.metamask', provider: p });
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    const seen = vi.fn();

    watchWalletAccount(seen);
    await settled();
    p.switchTo(); // MetaMask sends an empty array when it revokes a site

    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it('watches nothing for a passkey session (negative)', async () => {
    rememberWallet({ kind: 'passkey' });
    const seen = vi.fn();

    watchWalletAccount(seen);
    await settled();

    // A passkey has no selected account that can drift — the credential is the identity.
    expect(findWallet).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });

  it('unsubscribes, so a remounted provider does not leak a listener (regression)', async () => {
    const p = provider([A]);
    findWallet.mockResolvedValue({ rdns: 'io.metamask', provider: p });
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });

    const stop = watchWalletAccount(vi.fn());
    await settled();
    stop();

    expect(p.removeListener).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
  });

  it('stays quiet when the extension is locked or missing (negative)', async () => {
    findWallet.mockResolvedValue(null);
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    const seen = vi.fn();

    // Not an error state. A locked MetaMask does not mean the session is wrong, and reporting a
    // switch here would put a warning on screen for somebody who switched nothing.
    expect(() => watchWalletAccount(seen)).not.toThrow();
    await settled();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('sameAddress', () => {
  it('ignores capitalisation (regression)', () => {
    // Extensions hand back checksummed addresses; the backend stores lowercase. A `!==` here
    // reports a switch on every page load for a user who has switched nothing.
    expect(sameAddress(A, A.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('treats an unknown side as not a match (negative)', () => {
    expect(sameAddress(null, A)).toBe(false);
    expect(sameAddress(A, undefined)).toBe(false);
  });

  it('separates two real accounts (positive)', () => {
    expect(sameAddress(A, B)).toBe(false);
  });
});
