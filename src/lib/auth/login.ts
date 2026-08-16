import { endpoints } from '@/lib/api/endpoints';
import { tokenStore } from '@/lib/api/token-store';
import type { VerifyResponse } from '@/lib/api/types';
import type { WalletSigner } from '@/lib/wallet/types';

/**
 * SIWE login, signer-agnostic.
 *
 * 1. ask the backend for a nonce + ready-to-sign SIWE message
 * 2. sign it with whatever wallet the user connected
 * 3. exchange the signature for an access + refresh pair
 *
 * The message is built server-side, so domain/chainId always match and the
 * client never constructs auth material itself. After this, the refresh token
 * carries the session — the user does not sign again until it expires.
 */
export async function loginWithSigner(
  signer: WalletSigner,
  store = tokenStore,
): Promise<VerifyResponse> {
  const { message } = await endpoints.auth.nonce(signer.address);
  const signature = await signer.signMessage(message);
  const result = await endpoints.auth.verify(message, signature);

  store.setAccess(result.tokens.accessToken);
  store.setRefresh(result.tokens.refreshToken);

  // The signing session has served its purpose; drop the key from memory.
  signer.disconnect?.();

  return result;
}

/** Revoke the session server-side and clear local tokens. */
export async function logout(store = tokenStore): Promise<void> {
  const refreshToken = store.getRefresh();
  store.clear();
  if (!refreshToken) return;
  // Best-effort: a failed revoke must never block the user from signing out.
  await endpoints.auth.logout(refreshToken).catch(() => undefined);
}
