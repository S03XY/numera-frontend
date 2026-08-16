/**
 * A real EIP-1193 provider backed by a local key — MetaMask's shape, without
 * the extension.
 *
 * This exists so the live harness can drive the **injected-wallet** path rather
 * than the passkey path. The two are not interchangeable: an injected signer
 * carries a `provider` and no `evmAccount`, so `signerWalletClient` builds its
 * client with `custom(provider)` and viem sends `eth_sendTransaction` — the
 * exact call that once failed against a public RPC because a passkey account had
 * been passed as a bare address string. Testing with a `LocalAccount` would take
 * the `eth_sendRawTransaction` branch and never touch that code.
 *
 * So this implements what a browser wallet implements and nothing more:
 * `eth_sendTransaction` signs locally and forwards the raw transaction, chain
 * switches are answered rather than proxied, and everything else falls through
 * to the RPC. Reads are deliberately proxied rather than faked — the point is to
 * exercise the real node.
 *
 * Test-only. Nothing in the app imports it.
 */
import { createPublicClient, custom, http, type Chain, type LocalAccount } from 'viem';
import type { Eip1193Provider, WalletSigner } from './types';

export interface EoaWalletOptions {
  account: LocalAccount;
  chain: Chain;
  rpcUrl: string;
  /** Observe every RPC method the app asks for — useful when a call path is in doubt. */
  onRequest?: (method: string) => void;
}

/**
 * The provider half. Mirrors a wallet extension's method surface.
 *
 * `wallet_switchEthereumChain` succeeds silently because this wallet is already
 * on the target chain; a real one would prompt. `wallet_addEthereumChain` is
 * accepted for the same reason — `ensureChain` calls it on a 4902 and must not
 * see an unhandled rejection.
 */
export function eoaProvider(options: EoaWalletOptions): Eip1193Provider {
  const { account, chain, rpcUrl, onRequest } = options;
  const rpc = createPublicClient({ chain, transport: http(rpcUrl) });
  const chainIdHex = `0x${chain.id.toString(16)}`;

  return {
    async request({ method, params }) {
      onRequest?.(method);
      const args = (params ?? []) as unknown[];

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address];

        case 'eth_chainId':
          return chainIdHex;

        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;

        case 'personal_sign': {
          // EIP-1193 orders these [message, address]. Wallets accept a hex or a
          // utf-8 string; viem and the Unlink SDK both send hex.
          const [message] = args as [string];
          return account.signMessage({
            message: message.startsWith('0x')
              ? { raw: message as `0x${string}` }
              : message,
          });
        }

        case 'eth_signTypedData_v4': {
          const [, payload] = args as [string, string];
          return account.signTypedData(
            typeof payload === 'string' ? JSON.parse(payload) : payload,
          );
        }

        case 'eth_sendTransaction': {
          // What a browser wallet does: fill the gaps, sign, and submit the raw
          // transaction itself. The dapp never sees a private key and the node
          // never needs an unlocked account.
          const [tx] = args as [Record<string, unknown>];
          const to = tx.to as `0x${string}` | undefined;
          const data = tx.data as `0x${string}` | undefined;
          const value = tx.value ? BigInt(tx.value as string) : 0n;

          const [nonce, fees] = await Promise.all([
            rpc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
            rpc.estimateFeesPerGas(),
          ]);
          // Estimate rather than trust a caller-supplied limit: Monad reserves
          // `gas × maxFeePerGas` up front, so a padded guess can fail a
          // transaction the account could actually afford.
          const gas = tx.gas
            ? BigInt(tx.gas as string)
            : await rpc.estimateGas({ account: account.address, to, data, value });

          const signed = await account.signTransaction({
            chainId: chain.id,
            to,
            data,
            value,
            nonce,
            gas,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            type: 'eip1559',
          });
          return rpc.request({
            method: 'eth_sendRawTransaction',
            params: [signed],
          } as never);
        }

        default:
          // Reads (`eth_call`, `eth_getBalance`, receipts…) go to the real node,
          // which is what a wallet does too.
          return rpc.request({ method, params } as never);
      }
    },
  };
}

/**
 * The signer half, shaped exactly as `connectInjectedWallet` returns it:
 * `kind: 'injected'`, a provider, and **no** `evmAccount`.
 */
export function eoaSigner(options: EoaWalletOptions): WalletSigner {
  const provider = eoaProvider(options);
  return {
    address: options.account.address,
    kind: 'injected',
    provider,
    signMessage: (message: string) =>
      provider.request({
        method: 'personal_sign',
        params: [message, options.account.address],
      }) as Promise<string>,
  };
}

/** A viem transport over the double, for asserting on what the app would send. */
export const eoaTransport = (options: EoaWalletOptions) =>
  custom(eoaProvider(options) as Parameters<typeof custom>[0]);
