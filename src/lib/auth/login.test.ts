import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginWithSigner, logout } from './login';
import { createTokenStore } from '@/lib/api/token-store';
import { endpoints } from '@/lib/api/endpoints';
import { WalletError, type WalletSigner } from '@/lib/wallet/types';

vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    auth: {
      nonce: vi.fn(),
      verify: vi.fn(),
      logout: vi.fn(),
    },
  },
}));

const nonceMock = endpoints.auth.nonce as unknown as ReturnType<typeof vi.fn>;
const verifyMock = endpoints.auth.verify as unknown as ReturnType<typeof vi.fn>;
const logoutMock = endpoints.auth.logout as unknown as ReturnType<typeof vi.fn>;

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SIWE_MESSAGE = 'api.test wants you to sign in...\nNonce: abc123';

function fakeSigner(overrides: Partial<WalletSigner> = {}): WalletSigner {
  return {
    address: ADDRESS,
    kind: 'passkey',
    signMessage: vi.fn(async () => '0xsignature'),
    disconnect: vi.fn(),
    ...overrides,
  };
}

const verifyResult = {
  isNewUser: true,
  user: { id: 'u1', address: ADDRESS.toLowerCase(), displayName: null },
  tokens: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresIn: '900s',
    refreshExpiresIn: '30d',
  },
};

beforeEach(() => {
  nonceMock.mockReset().mockResolvedValue({
    message: SIWE_MESSAGE,
    nonce: 'abc123',
    expiresAt: new Date().toISOString(),
  });
  verifyMock.mockReset().mockResolvedValue(verifyResult);
  logoutMock.mockReset().mockResolvedValue(undefined);
});

describe('loginWithSigner', () => {
  it('runs nonce -> sign -> verify and stores both tokens (positive)', async () => {
    const store = createTokenStore();
    const signer = fakeSigner();

    const result = await loginWithSigner(signer, store);

    expect(nonceMock).toHaveBeenCalledWith(ADDRESS);
    expect(signer.signMessage).toHaveBeenCalledWith(SIWE_MESSAGE);
    expect(verifyMock).toHaveBeenCalledWith(SIWE_MESSAGE, '0xsignature');
    expect(result.isNewUser).toBe(true);
    expect(store.getAccess()).toBe('access-1');
    expect(store.getRefresh()).toBe('refresh-1');
  });

  it('signs the exact server-issued message, never a locally built one (security regression)', async () => {
    const store = createTokenStore();
    const signer = fakeSigner();
    await loginWithSigner(signer, store);
    const signed = (signer.signMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(signed).toBe(SIWE_MESSAGE);
  });

  it('releases key material after login (privacy)', async () => {
    const store = createTokenStore();
    const signer = fakeSigner();
    await loginWithSigner(signer, store);
    expect(signer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the user cancels the signature (negative)', async () => {
    const store = createTokenStore();
    const signer = fakeSigner({
      signMessage: vi.fn(async () => {
        throw new WalletError('CANCELLED', 'Request cancelled.');
      }),
    });

    await expect(loginWithSigner(signer, store)).rejects.toBeInstanceOf(WalletError);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(store.getAccess()).toBeNull();
    expect(store.getRefresh()).toBeNull();
  });

  it('stores nothing when the backend rejects the signature (negative)', async () => {
    verifyMock.mockRejectedValueOnce(new Error('401 Unauthorized'));
    const store = createTokenStore();

    await expect(loginWithSigner(fakeSigner(), store)).rejects.toThrow();
    expect(store.getAccess()).toBeNull();
  });

  it('does not sign when the nonce request fails (negative)', async () => {
    nonceMock.mockRejectedValueOnce(new Error('network'));
    const signer = fakeSigner();

    await expect(loginWithSigner(signer, createTokenStore())).rejects.toThrow();
    expect(signer.signMessage).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('revokes server-side and clears local tokens (positive)', async () => {
    const store = createTokenStore();
    store.setAccess('a');
    store.setRefresh('r');

    await logout(store);

    expect(logoutMock).toHaveBeenCalledWith('r');
    expect(store.getAccess()).toBeNull();
    expect(store.getRefresh()).toBeNull();
  });

  it('still clears locally when the revoke call fails (negative — must not trap the user)', async () => {
    logoutMock.mockRejectedValueOnce(new Error('server down'));
    const store = createTokenStore();
    store.setAccess('a');
    store.setRefresh('r');

    await expect(logout(store)).resolves.toBeUndefined();
    expect(store.getAccess()).toBeNull();
    expect(store.getRefresh()).toBeNull();
  });

  it('is a no-op when there is no session', async () => {
    await expect(logout(createTokenStore())).resolves.toBeUndefined();
    expect(logoutMock).not.toHaveBeenCalled();
  });
});
