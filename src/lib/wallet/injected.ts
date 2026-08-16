import { createWalletClient, custom, type WalletClient } from 'viem';
import { toWalletError, WalletError, type Eip1193Provider, type WalletSigner } from './types';

/**
 * Browser-extension wallets, discovered via EIP-6963.
 *
 * Numera offers this as a peer of the passkey, not a fallback: some people want
 * a key they already control, and a hardware-backed wallet behind MetaMask is a
 * legitimately stronger custody story than a device passkey.
 *
 * Three constraints shape this file:
 *
 *  - **EIP-6963, not `window.ethereum`.** With several extensions installed they
 *    fight over that single global, so whoever loaded last wins and the user has
 *    no say. 6963 lets every wallet announce itself and lets the user pick. The
 *    legacy global is kept only as a last resort for wallets that never adopted
 *    the standard.
 *  - **MetaMask only.** See {@link SUPPORTED_RDNS}.
 *  - **EOAs only.** Unlink derives your shielded identity by recovering the
 *    signer from one `personal_sign`, which a contract wallet (Safe, Argent)
 *    cannot satisfy — it signs with ERC-1271 instead. We detect that at connect
 *    time so the user is told plainly, rather than hitting an opaque failure
 *    after they have already funded an account they cannot spend from.
 */

/**
 * The one browser wallet this build supports.
 *
 * Every injected wallet speaks the same EIP-1193 methods, so listing all of them is easy and
 * testing all of them is not — and the parts of this product that touch a wallet are the parts
 * where being wrong costs money: `personal_sign` encoding (which decides your shielded identity),
 * EIP-712 for Permit2, and `wallet_addEthereumChain` for a testnet most wallets have never seen.
 * Those differ between extensions in ways that only show up in the failure.
 *
 * So the list is what we actually verify rather than whatever announced itself. A wallet that is
 * offered and then derives the wrong identity is worse than one that was never offered.
 */
export const SUPPORTED_RDNS = 'io.metamask';

/** Whether a legacy `window.ethereum` is MetaMask, for providers that predate EIP-6963. */
function isLegacyMetaMask(provider: unknown): boolean {
  return (provider as { isMetaMask?: boolean } | null)?.isMetaMask === true;
}

/** A wallet that announced itself, as EIP-6963 defines it. */
export interface InjectedWallet {
  /** Reverse-DNS id, e.g. `io.metamask`. Stable across sessions — we persist it. */
  rdns: string;
  name: string;
  /** Data URI. 6963 mandates this, so it never triggers a network request. */
  icon: string;
  provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  detail: {
    info: { uuid: string; name: string; icon: string; rdns: string };
    provider: Eip1193Provider;
  };
}

/**
 * Listen for wallet announcements.
 *
 * Returns an unsubscribe function. Announcements are synchronous-ish but not
 * instant, and a wallet may announce late (an extension still waking up), so
 * this stays subscribed rather than resolving a one-shot promise.
 */
export function subscribeToInjectedWallets(
  onChange: (wallets: InjectedWallet[]) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const found = new Map<string, InjectedWallet>();

  const onAnnounce = (event: Event) => {
    const { info, provider } = (event as Eip6963AnnounceEvent).detail;
    // Keyed by rdns, not uuid: uuid is regenerated per page load, so keying on
    // it would list the same wallet twice if it announced more than once.
    if (!info?.rdns || found.has(info.rdns)) return;
    // Everything else announcing on this page is ignored rather than listed — see SUPPORTED_RDNS.
    if (info.rdns !== SUPPORTED_RDNS) return;
    found.set(info.rdns, {
      rdns: info.rdns,
      name: info.name,
      icon: info.icon,
      provider,
    });
    onChange([...found.values()]);
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Wallets that predate 6963 only ever set the global. Adopt it if nothing announced, so a
  // MetaMask too old to announce is not locked out — but only if the global actually IS MetaMask.
  // Without that check this is a back door that relists every wallet the filter above just
  // excluded, since whichever extension won the race owns `window.ethereum`.
  const legacy = (window as { ethereum?: Eip1193Provider }).ethereum;
  if (legacy && isLegacyMetaMask(legacy)) {
    queueMicrotask(() => {
      if (found.size > 0) return;
      found.set(LEGACY_RDNS, {
        rdns: LEGACY_RDNS,
        name: 'MetaMask',
        icon: '',
        provider: legacy,
      });
      onChange([...found.values()]);
    });
  }

  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
}

export const LEGACY_RDNS = 'window.ethereum';

/** Collect whatever has announced within `timeoutMs`. Used by non-React callers. */
export function discoverInjectedWallets(timeoutMs = 300): Promise<InjectedWallet[]> {
  return new Promise((resolve) => {
    let latest: InjectedWallet[] = [];
    const stop = subscribeToInjectedWallets((wallets) => {
      latest = wallets;
    });
    setTimeout(() => {
      stop();
      resolve(latest);
    }, timeoutMs);
  });
}

/**
 * Is this address a contract?
 *
 * EIP-7702 muddies the question: a delegated EOA *does* carry code, but it is a
 * 23-byte designator (`0xef0100‖address`) and the underlying key still signs
 * ECDSA, so `personal_sign` recovery works and Unlink is happy. Treating those
 * as contract wallets would reject a growing share of ordinary MetaMask users.
 */
export function isContractAccount(code: string | null | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  return !code.toLowerCase().startsWith('0xef0100');
}

async function assertEoa(provider: Eip1193Provider, address: string): Promise<void> {
  let code: unknown;
  try {
    code = await provider.request({ method: 'eth_getCode', params: [address, 'latest'] });
  } catch {
    // A wallet that will not answer `eth_getCode` is not grounds for refusing
    // the connection. Unlink's own signature-recovery check is the real gate;
    // this is only here to fail early with a better message.
    return;
  }
  if (isContractAccount(typeof code === 'string' ? code : null)) {
    throw new WalletError(
      'SMART_ACCOUNT',
      'This looks like a smart-contract wallet. Numera needs a regular wallet account (an EOA) to derive your private balance — please switch accounts and try again.',
    );
  }
}

export interface ConnectOptions {
  /**
   * Reopen the wallet's own account picker before reading the account.
   *
   * Off by default, and the default is the safety property rather than a preference. Every caller
   * except an explicit sign-in gesture is *re-acquiring* the key an existing session was already
   * derived from, and a picker there offers a choice whose only correct answer is the one already
   * in use. Unlocking is the worst of them: the account chosen at that moment seeds the shielded
   * identity and every market account under it.
   */
  chooseAccount?: boolean;
}

/**
 * Ask the wallet to re-offer its accounts for this origin.
 *
 * ## The bug this exists for
 *
 * `eth_requestAccounts` does not mean "ask the user which account". For an origin that already
 * holds an `eth_accounts` permission, MetaMask answers it from the stored permission and never
 * opens anything, so it returns the account that was granted however long ago, whatever the
 * extension is showing now. Selecting a different account in MetaMask grants this site nothing:
 * the new account is absent from `eth_accounts`, and no `accountsChanged` fires either, because
 * that event reports changes to the *permitted* set rather than to the selected one.
 *
 * The result is a site that cannot see the account the user is looking at, and a user who has to
 * go into the extension and connect it by hand before the page will admit it exists.
 *
 * `wallet_requestPermissions` is the only method that reopens the picker and rewrites the
 * permission. It is EIP-2255, and the array wrapper on the params is required by it: a bare
 * `{ eth_accounts: {} }` type checks perfectly and fails at runtime with `-32602`.
 *
 * ## Why the return value is thrown away
 *
 * The grant does carry the accounts, in a caveat. Reading them there would create a second source
 * for the address that seeds the shielded identity, and the shape is not something to rely on:
 * the caveat name has already changed once historically, MetaMask's own documented example
 * returns an empty caveat list, and its docs point at `wallet_getPermissions` for reading the set.
 * One source, `eth_requestAccounts`, is worth more than saving a round trip.
 */
export async function requestAccountAccess(provider: Eip1193Provider): Promise<boolean> {
  try {
    await provider.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    return true;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    // Saying no, and a dialog already open, are the two answers. Everything else means the wallet
    // could not be asked, which is not a reason to refuse a connection that would have worked.
    if (code === 4001 || code === -32002) throw toWalletError(err, 'CANCELLED');

    /*
      Everything else is swallowed, deliberately and widely.

      There is no capability discovery to check first: EIP-6963 announces that a wallet exists and
      says nothing about which RPC methods it implements, so the only signal is the failure. The
      codes seen in the wild for "I do not have this" are 4200, -32601, -32602, and -32603 from
      providers that wrap the others in "Internal JSON-RPC error", plus throws carrying no code at
      all. Enumerating them would turn the next unlisted one into a locked-out user.

      Not a hypothetical class of wallet, either. The legacy branch of `subscribeToInjectedWallets`
      adopts any `window.ethereum` with `isMetaMask === true`, and Coinbase Wallet, Trust, OKX and
      Rabby all set that flag for compatibility. A fatal permission call would refuse them all,
      under an error that reads as "you have no wallet".

      Swallowed is not the same as ignored, which is what the boolean is for. Connecting genuinely
      does not care, because it falls through to `eth_requestAccounts` and gets an account either
      way. A caller whose *entire* purpose was to reopen the picker does care: for that one,
      swallowing silently is a button that does nothing and says nothing.
    */
    return false;
  }
}

/**
 * Connect a specific wallet and return a signer.
 *
 * The chain is deliberately NOT switched here. Signing in and deriving the
 * shielded identity are both chain-agnostic, so demanding a network change at
 * the door is a prompt for nothing. `ensureMonadChain` runs later, only for the
 * two flows that actually send a transaction.
 */
export async function connectInjectedWallet(
  wallet: InjectedWallet,
  options?: ConnectOptions,
): Promise<WalletSigner> {
  const { provider } = wallet;

  // Before the read, never after: once `eth_requestAccounts` has answered from the stored
  // permission, the picker has been skipped and there is nothing left to choose.
  if (options?.chooseAccount) await requestAccountAccess(provider);

  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (err) {
    throw toWalletError(err, 'UNSUPPORTED');
  }

  const address = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new WalletError('CANCELLED', 'No account was shared by the wallet.');
  }

  await assertEoa(provider, address);

  // viem rather than a raw `personal_sign`: it hex-encodes the message the way
  // EIP-191 requires, which several wallets are strict about.
  const client: WalletClient = createWalletClient({
    account: address as `0x${string}`,
    transport: custom(provider as Parameters<typeof custom>[0]),
  });

  return {
    address,
    kind: 'injected',
    provider,
    async signMessage(message: string) {
      try {
        return await client.signMessage({
          account: address as `0x${string}`,
          message,
        });
      } catch (err) {
        throw toWalletError(err, 'SIGN_FAILED');
      }
    },
    // No `disconnect`: the key lives in the extension, so there is nothing here
    // to zero. Calling one would also be a lie — the site stays connected.
  };
}

/**
 * Find an announced wallet by its rdns, waiting briefly for it to appear.
 *
 * A named rdns must match exactly. This used to fall through to `wallets[0]` when the requested
 * wallet was missing, which is the most expensive kind of helpfulness available here: the caller
 * is `reconnectWallet`, re-acquiring the key a session was already derived from, and handing it a
 * *different* wallet produces a different shielded identity — silently, with no error, because
 * both identities are perfectly valid. Anything already in the pool becomes unreachable.
 *
 * That path is live now rather than hypothetical: a browser that signed in with some other
 * extension before this build still has its rdns remembered, and that wallet is no longer offered.
 * Returning null gets them a sentence telling them so; the fallback would have quietly moved them
 * onto MetaMask and stranded whatever they had.
 *
 * An empty request keeps the fallback — that is a preference written before rdns was recorded, so
 * there is no identity to contradict.
 */
export async function findInjectedWallet(rdns: string): Promise<InjectedWallet | null> {
  const wallets = await discoverInjectedWallets();
  if (!rdns) return wallets[0] ?? null;
  return wallets.find((w) => w.rdns === rdns) ?? null;
}

/**
 * Move the wallet to Monad testnet, adding it if the wallet has never seen it.
 *
 * Called immediately before a transaction, never at connect time. A wrong-chain
 * transaction is not merely rejected — it could in principle be broadcast on
 * whatever chain the wallet is on, so this is a correctness guard, not polish.
 */
export async function ensureChain(
  provider: Eip1193Provider,
  chain: {
    id: number;
    name: string;
    /**
     * All endpoints, best first. Plural on purpose: a wallet that only ever
     * learns one RPC will hang at "confirming" the moment that endpoint is
     * throttled, with no diagnosis available to the site — the extension owns
     * the broadcast and never reports why.
     */
    rpcUrls: string[];
    explorerUrl?: string;
    symbol: string;
  },
): Promise<void> {
  const hexId = `0x${chain.id.toString(16)}`;

  const current = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  if (typeof current === 'string' && current.toLowerCase() === hexId.toLowerCase()) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
    return;
  } catch (err) {
    // 4902 = chain unknown to the wallet. Anything else (including the user
    // declining) is final.
    const code = (err as { code?: number })?.code;
    if (code !== 4902 && code !== -32603) throw toWalletError(err, 'WRONG_NETWORK');
  }

  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
          rpcUrls: chain.rpcUrls,
          ...(chain.explorerUrl ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
        },
      ],
    });
  } catch (err) {
    throw toWalletError(err, 'WRONG_NETWORK');
  }
}
