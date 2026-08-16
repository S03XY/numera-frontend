import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  type LocalAccount,
  type WalletClient,
} from 'viem';
import { ensureChain } from '@/lib/wallet/injected';
import { WalletError, type WalletSigner } from '@/lib/wallet/types';
import { DEFAULT_CHAIN_ID } from './collateral';

/**
 * Public-chain access, for the two flows that are unavoidably public.
 *
 * Almost nothing Numera does touches a user's own address. Trades come from derived market accounts
 * and are relayed; withdrawals from the shielded pool are relayed; the accounts hold no gas and
 * never will. Two things are different:
 *
 *   - **entering the pool** — depositing needs a real approval and a real transaction from an
 *     address that actually holds the collateral;
 *   - **the testnet faucet** — `TestUSDC.faucet()` is an ordinary call.
 *
 * Both come from the user's own public address, which therefore needs a little native MON. That is
 * inherent rather than a shortcoming: value has to enter a shielded pool from somewhere public.
 * Once inside, nothing else touches this layer.
 *
 * Lives in `lib/chain` rather than beside a vendor, because none of it is anybody's but ours.
 */

const RPC_URL = process.env.NEXT_PUBLIC_RPC_HTTP_URL || 'https://testnet-rpc.monad.xyz';

/**
 * Every endpoint we are willing to talk to, best first.
 *
 * `https://testnet-rpc.monad.xyz` is Monad's official testnet RPC and is the
 * only one contacted by default. Third-party endpoints are **not** baked in:
 * they vary in which methods they expose, and a silent failover to one of them
 * turns a local problem into a confusing error naming a host the operator never
 * chose — which is exactly what happened here.
 *
 * Failover still exists, but only across endpoints a deployment opts into via
 * `NEXT_PUBLIC_RPC_FALLBACK_URLS`. With none set this is a single-endpoint list
 * and behaves exactly like a plain `http()` transport.
 */
const RPC_URLS: string[] = [
  ...new Set(
    [
      RPC_URL,
      ...(process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ].filter(Boolean),
  ),
];

/**
 * Transport with automatic failover.
 *
 * `rank: false` keeps the declared order rather than continuously re-ranking by
 * latency: re-ranking issues background probes to every endpoint, which is a
 * good way to get rate-limited by the very RPCs we are trying to conserve.
 */
function transport() {
  return fallback(
    RPC_URLS.map((url) => http(url, { retryCount: 2, timeout: 15_000 })),
    { rank: false },
  );
}

/**
 * Monad testnet.
 *
 * Defined locally rather than imported from `viem/chains` so the chain id stays pinned to the same
 * constant every key derivation is bound to. A mismatch there does not fail — it silently derives a
 * different set of notes and market accounts, and shows the trader an empty balance that is
 * nobody's bug.
 */
export const monadTestnet = defineChain({
  id: DEFAULT_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
  },
  testnet: true,
});

export function publicClient() {
  return createPublicClient({ chain: monadTestnet, transport: transport() });
}

export function walletClient(account: LocalAccount) {
  return createWalletClient({ account, chain: monadTestnet, transport: transport() });
}

/**
 * A transaction-capable client for whichever wallet the user brought.
 *
 * The two signer kinds differ in where the key lives, and that difference has
 * to be resolved exactly once:
 *
 *  - **Passkey (Mera)** — the key is in memory here, so we sign locally and
 *    broadcast through our own RPC. Nothing to switch; the chain is ours.
 *  - **Injected** — the key never leaves the extension, so both signing and
 *    broadcasting go through its provider. Which means it has to be *on* Monad
 *    first, and this is the moment to make sure of that: the user is about to
 *    send a transaction, so a network prompt is expected rather than baffling.
 *
 * Callers get a `WalletClient` either way and never branch on wallet type.
 */
export async function signerWalletClient(signer: WalletSigner): Promise<WalletClient> {
  if (signer.evmAccount) return walletClient(signer.evmAccount);

  if (signer.provider) {
    await ensureChain(signer.provider, {
      id: monadTestnet.id,
      name: monadTestnet.name,
      rpcUrls: RPC_URLS,
      explorerUrl: monadTestnet.blockExplorers?.default.url,
      symbol: monadTestnet.nativeCurrency.symbol,
    });
    return createWalletClient({
      account: signer.address as `0x${string}`,
      chain: monadTestnet,
      transport: custom(signer.provider as Parameters<typeof custom>[0]),
    });
  }

  throw new WalletError(
    'UNSUPPORTED',
    'This wallet cannot send transactions, so it cannot fund or withdraw.',
  );
}

/**
 * Adapt a viem wallet client into the `EvmProvider` the Unlink SDK wants.
 *
 * `evm.fromViem` (wallet + public client) rather than `evm.fromViemAccount`
 * (signing only): the deposit path needs `sendTransaction`, `getCode` and
 * `eth_call` as well as `signTypedData`, and a bare local account has no RPC.
 *
 * The public client is always ours. Reads go to an RPC we chose even when the
 * signing half belongs to an extension, so a wallet pointed at a stale or
 * throttled endpoint cannot make a deposit look like it failed.
 */
