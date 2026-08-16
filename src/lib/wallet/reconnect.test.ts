import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mera', () => ({
  connectPasskeyWallet: vi.fn(async () => ({
    address: '0xpasskey',
    kind: 'passkey' as const,
    signMessage: async () => '0x',
  })),
}));

vi.mock('./injected', () => ({
  findInjectedWallet: vi.fn(),
  connectInjectedWallet: vi.fn(async () => ({
    address: '0xinjected',
    kind: 'injected' as const,
    signMessage: async () => '0x',
  })),
}));

const { connectPasskeyWallet } = await import('./mera');
const { findInjectedWallet, connectInjectedWallet } = await import('./injected');
const { forgetWallet, readWalletPreference, reconnectWallet, rememberWallet } = await import(
  './reconnect'
);

const passkey = connectPasskeyWallet as unknown as ReturnType<typeof vi.fn>;
const findWallet = findInjectedWallet as unknown as ReturnType<typeof vi.fn>;
const connectWallet = connectInjectedWallet as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wallet preference', () => {
  it('round-trips a passkey choice (positive)', () => {
    rememberWallet({ kind: 'passkey' });
    expect(readWalletPreference()).toEqual({ kind: 'passkey' });
  });

  it('round-trips an injected choice with its rdns (positive)', () => {
    rememberWallet({ kind: 'injected', rdns: 'io.rabby' });
    expect(readWalletPreference()).toEqual({ kind: 'injected', rdns: 'io.rabby' });
  });

  it('returns null when nothing is stored (negative)', () => {
    expect(readWalletPreference()).toBeNull();
  });

  it('ignores corrupt JSON rather than throwing (negative)', () => {
    window.localStorage.setItem('numera.wallet.preference', '{not json');
    expect(readWalletPreference()).toBeNull();
  });

  it('ignores an unknown kind (negative)', () => {
    window.localStorage.setItem('numera.wallet.preference', '{"kind":"ledger"}');
    expect(readWalletPreference()).toBeNull();
  });

  it('survives localStorage being unavailable (negative)', () => {
    // Private browsing throws on write. Losing the preference is acceptable;
    // failing the login over it is not.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => rememberWallet({ kind: 'passkey' })).not.toThrow();
  });

  it('forgets the choice (positive)', () => {
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    forgetWallet();
    expect(readWalletPreference()).toBeNull();
  });
});

describe('reconnectWallet', () => {
  it('reconnects the passkey when that is what was used (positive)', async () => {
    rememberWallet({ kind: 'passkey' });
    await expect(reconnectWallet()).resolves.toMatchObject({ kind: 'passkey' });
    expect(findWallet).not.toHaveBeenCalled();
  });

  it('reconnects the same extension the user signed in with (positive)', async () => {
    findWallet.mockResolvedValue({ rdns: 'io.rabby', name: 'Rabby', icon: '', provider: {} });
    rememberWallet({ kind: 'injected', rdns: 'io.rabby' });

    await expect(reconnectWallet()).resolves.toMatchObject({ kind: 'injected' });
    expect(findWallet).toHaveBeenCalledWith('io.rabby');
    expect(passkey).not.toHaveBeenCalled();
  });

  it('never shows a passkey prompt to a wallet user (regression)', async () => {
    // This is the whole reason the module exists. A passkey prompt here would
    // derive a DIFFERENT — and perfectly valid — shielded identity, hiding any
    // funds already in the pool with no error to explain it.
    findWallet.mockResolvedValue(null);
    rememberWallet({ kind: 'injected', rdns: 'io.metamask' });

    await expect(reconnectWallet()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(passkey).not.toHaveBeenCalled();
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it('falls back to the passkey for a first-time visitor (positive)', async () => {
    await expect(reconnectWallet()).resolves.toMatchObject({ kind: 'passkey' });
  });

  /*
    Matching the extension was never enough.

    `rdns` identifies MetaMask, not which of MetaMask's accounts is selected, and the account is
    what derives the shielded identity. So a user who switched accounts and then unlocked used to
    open a *different* private balance: valid, empty, and with the real one nowhere on screen. The
    tests above all pass in that world, which is why these exist.
  */
  describe('with the signed-in address pinned', () => {
    const signedIn = '0x1111111111111111111111111111111111111111';

    beforeEach(() => {
      findWallet.mockResolvedValue({
        rdns: 'io.metamask',
        name: 'MetaMask',
        icon: '',
        provider: {},
      });
      rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    });

    it('returns the signer when the wallet is still on that account (positive)', async () => {
      connectWallet.mockResolvedValue({ address: signedIn, kind: 'injected' as const });
      await expect(reconnectWallet(signedIn)).resolves.toMatchObject({ address: signedIn });
    });

    it('accepts a different capitalisation of the same address (regression)', async () => {
      // Extensions return mixed-case checksummed addresses and the backend stores lowercase. A
      // literal comparison here would refuse every reconnect for every wallet user.
      connectWallet.mockResolvedValue({ address: signedIn.toUpperCase().replace('0X', '0x') });
      await expect(reconnectWallet(signedIn)).resolves.toBeTruthy();
    });

    it('refuses a wallet that has switched accounts (negative)', async () => {
      connectWallet.mockResolvedValue({
        address: '0x2222222222222222222222222222222222222222',
        kind: 'injected' as const,
      });

      await expect(reconnectWallet(signedIn)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' });
    });

    it('names both accounts, because the fix is a decision and not a retry (negative)', async () => {
      connectWallet.mockResolvedValue({ address: '0x2222222222222222222222222222222222222222' });

      await expect(reconnectWallet(signedIn)).rejects.toThrow(/0x2222/);
      await expect(reconnectWallet(signedIn)).rejects.toThrow(/0x1111/);
    });

    it('still returns whatever is selected when nothing is pinned (positive)', async () => {
      // The callers that have no session to protect — there is no identity to contradict yet.
      connectWallet.mockResolvedValue({ address: '0x2222222222222222222222222222222222222222' });
      await expect(reconnectWallet()).resolves.toBeTruthy();
    });

    it('does not retry with a picker after refusing a switched account (negative)', async () => {
      // The helpful-looking recovery is the expensive one. Reopening the account picker here
      // would let somebody grant the wrong account into a session that is mid unlock, and the
      // identity derived from it would be valid, empty, and not the one holding their funds.
      connectWallet.mockResolvedValue({ address: '0x2222222222222222222222222222222222222222' });

      await expect(reconnectWallet(signedIn)).rejects.toMatchObject({ code: 'WRONG_ACCOUNT' });
      expect(connectWallet).toHaveBeenCalledTimes(1);
    });
  });

  /*
    Re-acquisition must never open the wallet's account picker.

    Signing in asks which account to share, because that is a choice the person is making. Every
    caller here is the opposite: unlocking, the faucet, a deposit, an admin resolve, each
    re-acquiring the key a session was already derived from. A picker at those moments offers a
    choice whose only correct answer is the account already in use, and the wrong answer opens a
    different private balance.

    This file mocks `./injected` wholesale and, until these, asserted only *whether*
    `connectInjectedWallet` was called and never with what. The flag could have been inverted here
    and every other test stayed green.
  */
  describe('never opens the account picker', () => {
    beforeEach(() => {
      findWallet.mockResolvedValue({
        rdns: 'io.metamask',
        name: 'MetaMask',
        icon: '',
        provider: {},
      });
      connectWallet.mockResolvedValue({ address: '0x1111111111111111111111111111111111111111' });
      rememberWallet({ kind: 'injected', rdns: 'io.metamask' });
    });

    it('re-acquires silently when an address is pinned (MONEY REGRESSION)', async () => {
      await reconnectWallet('0x1111111111111111111111111111111111111111');

      const options = connectWallet.mock.calls[0][1] as { chooseAccount?: boolean } | undefined;
      expect(options?.chooseAccount).toBeFalsy();
    });

    it('stays silent even when nothing is pinned (regression)', async () => {
      // Silence must not be conditional on the pin, or the paths that pass no address — the ones
      // that run before a session exists — would start prompting.
      await reconnectWallet();

      const options = connectWallet.mock.calls[0][1] as { chooseAccount?: boolean } | undefined;
      expect(options?.chooseAccount).toBeFalsy();
    });
  });
});
