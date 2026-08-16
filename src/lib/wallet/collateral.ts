import { encodeFunctionData, parseAbi, type WalletClient } from 'viem';
import { monadTestnet, publicClient } from '@/lib/chain/evm';

/**
 * The public side of the wallet: what a user holds before they shield it, and how they get some.
 *
 * Everything here happens from the user's own address and is visible to anyone watching. That is
 * fine and unavoidable — value has to enter a shielded pool from somewhere public — and it is the
 * last point at which the trader is identifiable. Every action after a deposit runs through a
 * derived account funded out of the anonymity set.
 *
 * Split out of the old `unlink/funding.ts`, which mixed these three ordinary reads with a vendor's
 * deposit protocol. The vendor is gone; the reads were never theirs.
 */

/** `TestUSDC`, the testnet collateral. */
export const TEST_USDC_ABI = parseAbi([
  'function faucet()',
  'function faucetCooldownRemaining(address account) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export class FundingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FundingError';
  }
}

/**
 * The account a wallet client will send from — the **object**, never the address.
 *
 * This distinction is the difference between a working transaction and a broken one. viem decides
 * how to broadcast from the *type* of what it is given: an `Account` object of type `local` is
 * signed here and sent as a raw transaction, while a bare `0x…` address means "the node holds the
 * key" and becomes an `eth_sendTransaction` against a public RPC that has never heard of it. Ankr
 * and friends answer, correctly, "Method not found" — which reads as an RPC outage and is nothing
 * of the kind.
 *
 * Passing the account through unchanged is also what keeps injected wallets working: theirs is a
 * `json-rpc` account, so viem routes to the extension, which does hold the key.
 */
function senderOf(wallet: WalletClient): NonNullable<WalletClient['account']> {
  const account = wallet.account;
  if (!account) throw new FundingError('This wallet has no account selected.');
  return account;
}

/** The caller's public balance of `token` — what they could still deposit. */
export async function publicBalance(token: string, owner: string): Promise<bigint> {
  return publicClient().readContract({
    address: token as `0x${string}`,
    abi: TEST_USDC_ABI,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
  });
}

/**
 * The caller's native MON balance.
 *
 * Worth surfacing rather than discovering at signing time: entering the pool
 * costs gas, so a brand-new account with zero MON cannot claim collateral or
 * deposit, and every button they press will fail for a reason the UI would
 * otherwise never name.
 */
export async function nativeBalance(owner: string): Promise<bigint> {
  return publicClient().getBalance({ address: owner as `0x${string}` });
}

/**
 * Refuse to sign a transaction the account demonstrably cannot pay for.
 *
 * Monad reserves `gas × maxFeePerGas` up front and rejects the broadcast with
 * "Signer had insufficient balance" — accurate, but it arrives from the RPC
 * *after* signing, wrapped in a wall of hex, and names neither the account nor
 * the fact that all it needs is a little MON.
 *
 * Checking first turns that into one sentence the user can act on. The floor is
 * deliberately generous rather than an exact quote: a precise estimate would
 * need the gas limit and fee for a call we have not built yet, and being
 * approximately right here is worth far more than being exactly right.
 */
async function assertCanPayGas(owner: `0x${string}`): Promise<void> {
  const balance = await publicClient().getBalance({ address: owner });
  if (balance > 0n) return;
  /*
    The address is named, and that is not decoration.

    This used to say "the address shown above", which is true right up until the moment it is the
    thing that has gone wrong: if the wallet hands back a different account than the session was
    built on, the panel shows a funded address and this check reads an empty one. Pointing at the
    screen then sends the user to fund an account that already has money, over and over.

    Naming the account it actually looked at makes that visible in one glance.
  */
  throw new FundingError(
    `${owner} holds no MON, so it cannot pay for a transaction. If that is not the address shown ` +
      "above, your wallet has opened a different account. Otherwise claim a little from Monad's " +
      'testnet faucet and try again.',
  );
}

/** Seconds until this address may use the testnet faucet again; 0 means now. */
export async function faucetCooldown(token: string, owner: string): Promise<bigint> {
  return publicClient().readContract({
    address: token as `0x${string}`,
    abi: TEST_USDC_ABI,
    functionName: 'faucetCooldownRemaining',
    args: [owner as `0x${string}`],
  });
}

/**
 * Claim testnet collateral to the user's public address.
 *
 * Costs gas, so that address needs a little native MON first. The contract
 * rate-limits per address, so a tester cannot mint enough to distort the books.
 *
 * Resolves once the claim is **mined**, not once it is broadcast. That distinction is the whole
 * difference between a working button and a broken-looking one: the caller refetches balances the
 * moment this returns, and a transaction that is only in the mempool has moved nothing yet. So the
 * figure came back identical, the toast said the collateral had been claimed, and the two
 * contradicted each other until the user reloaded the page.
 */
export async function claimTestTokens(params: {
  token: string;
  wallet: WalletClient;
}): Promise<`0x${string}`> {
  const { token, wallet } = params;
  const sender = senderOf(wallet);

  await assertCanPayGas(sender.address);

  const remaining = await faucetCooldown(token, sender.address);
  if (remaining > 0n) {
    // Fail before asking the user to sign something guaranteed to revert.
    throw new FundingError(
      `The faucet is on cooldown for another ${formatDuration(remaining)}.`,
    );
  }

  const hash = await wallet.sendTransaction({
    account: sender,
    chain: monadTestnet,
    to: token as `0x${string}`,
    data: encodeFunctionData({ abi: TEST_USDC_ABI, functionName: 'faucet' }),
  });

  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new FundingError(`The faucet transaction failed (${hash}). Nothing was claimed.`);
  }
  return hash;
}

/** Human-readable countdown for faucet cooldown messages. */
export function formatDuration(seconds: bigint): string {
  const total = Number(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}
