'use client';

import * as React from 'react';
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseAbi } from 'viem';
import { monadTestnet, publicClient, signerWalletClient } from '@/lib/chain/evm';
import { useSession } from '@/lib/auth/useSession';
import { reconnectWallet } from '@/lib/wallet/reconnect';
import { toWalletError, type WalletSigner } from '@/lib/wallet/types';

/**
 * The operator's three moves on a market, signed by the operator's own wallet.
 *
 * ## Why none of this is a server endpoint
 *
 * The backend holds no key that can settle anything. Compromising our API therefore cannot resolve
 * a market — the only way in is a wallet holding the right role on chain. Adding or removing an
 * operator is `grantRole` / `revokeRole` from the resolver's admin, with no redeploy and no code
 * change here.
 *
 * ## Why it is not routed through Unlink either
 *
 * Every trader action is shielded, because who placed a bet must stay hidden. This is the opposite:
 * the operator is exercising a public, role-gated authority, and the record of who did what is a
 * feature. A shielded operator would be a worse product, not a better one.
 *
 * ## The three moves, and why they are separate
 *
 *  - **propose** — assert a result. Free of a bond because the caller holds `RESOLVER_ROLE`, and
 *    deliberately *not* final: it opens the same challenge window as a stranger's proposal.
 *  - **finalize** — settle a proposal nobody challenged. Permissionless: anyone can send it, and
 *    the reward still goes to the recorded proposer, so the operator doing it is a courtesy rather
 *    than a power.
 *  - **arbitrate** — overturn or uphold, through the signer quorum. The only one that is final, and
 *    the only one that cannot be done by a lone wallet.
 */

export type OperatorResult =
  | { ok: true; txHash: string }
  | {
      ok: false;
      reason:
        | 'cancelled'
        | 'not-closed'
        | 'not-authorised'
        | 'already-settled'
        | 'window-open'
        | 'failed';
      message: string;
    };

const RESOLVER_ABI = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function finalize(address market, uint256 marketId)',
  'function arbitrate(address market, uint256 marketId, uint256 trueOutcomeId)',
]);

const MULTISIG_ABI = parseAbi([
  'function propose(address target, bytes data) returns (uint256)',
  'function confirm(uint256 id)',
  'function pendingProposal(address target, bytes data) view returns (bool exists, uint256 id)',
]);

/** `OptimisticResolver.INVALID_OUTCOME` — the sentinel meaning "void this market". */
export const INVALID_OUTCOME = 4_294_967_295n;

type Hex = `0x${string}`;

export interface MarketTarget {
  /** `OptimisticResolver`. */
  resolver: string;
  /** The engine contract holding the market. */
  market: string;
  marketId: bigint;
}

/** `null` means "void this market", which the contract spells as a sentinel rather than a flag. */
function outcomeArg(outcomeId: number | null): bigint {
  return outcomeId === null ? INVALID_OUTCOME : BigInt(outcomeId);
}

/** The custom error viem decoded, if it decoded one. */
function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? null) : null;
}

/** Map a revert into copy that names the actual cause. */
function explain(err: unknown, fallback: string): OperatorResult {
  const named = revertName(err);
  const text = `${named ?? ''} ${fallback}`.toLowerCase();

  if (text.includes('marketnotclosed')) {
    return {
      ok: false,
      reason: 'not-closed',
      message: 'This market has not reached its close time yet, so nothing can be proposed.',
    };
  }
  if (text.includes('marketalreadysettled') || text.includes('proposalexists')) {
    return {
      ok: false,
      reason: 'already-settled',
      message: 'This market already has a proposal on it, or has already been settled.',
    };
  }
  if (text.includes('disputewindowopen')) {
    return {
      ok: false,
      reason: 'window-open',
      message: 'The challenge window is still open. It cannot be settled until that has passed.',
    };
  }
  if (
    text.includes('accesscontrol') ||
    text.includes('unauthorized') ||
    text.includes('notsigner') ||
    text.includes('missing role')
  ) {
    return {
      ok: false,
      reason: 'not-authorised',
      message: 'This wallet does not hold the role this action needs.',
    };
  }
  return { ok: false, reason: 'failed', message: named ?? fallback };
}

export function useOperatorResolution() {
  const [busy, setBusy] = React.useState(false);
  // Operator actions are sent from the operator's own wallet and checked against an on-chain
  // role. A wallet that has switched accounts since sign-in holds a different role, or none,
  // and the resulting revert names the contract rather than the cause.
  const { user } = useSession();
  const signedIn = user?.address ?? null;

  /**
   * Simulate, then send, then wait.
   *
   * The simulation is not decoration. Every action here is irreversible and costs gas, and on Monad
   * the declared gas limit is billed whether the call succeeds or not — so a revert discovered by
   * sending is a revert paid for in full. Catching it in an `eth_call` names the reason instead.
   */
  const send = React.useCallback(async (to: Hex, data: Hex): Promise<OperatorResult> => {
    setBusy(true);
    let signer: WalletSigner | null = null;
    try {
      signer = await reconnectWallet(signedIn);
      const wallet = await signerWalletClient(signer);
      // The account OBJECT, not the address: a bare address makes viem assume the node holds the
      // key and emit `eth_sendTransaction`, which a public RPC rightly rejects.
      if (!wallet.account) {
        return { ok: false, reason: 'failed', message: 'This wallet has no account selected.' };
      }

      const client = publicClient();
      await client.call({ account: signer.address as Hex, to, data });

      const hash = await wallet.sendTransaction({
        account: wallet.account,
        chain: monadTestnet,
        to,
        data,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        return { ok: false, reason: 'failed', message: `Transaction reverted (${hash}).` };
      }
      return { ok: true, txHash: hash };
    } catch (err) {
      const walletError = toWalletError(err);
      if (walletError.code === 'CANCELLED') {
        return { ok: false, reason: 'cancelled', message: '' };
      }
      return explain(err, err instanceof Error ? err.message : String(err));
    } finally {
      signer?.disconnect?.();
      setBusy(false);
    }
  }, [signedIn]);

  /** Assert a result without a bond. Opens the same challenge window as anyone else's proposal. */
  const propose = React.useCallback(
    (target: MarketTarget, outcomeId: number | null) =>
      send(
        target.resolver as Hex,
        encodeFunctionData({
          abi: RESOLVER_ABI,
          functionName: 'propose',
          args: [target.market as Hex, target.marketId, outcomeArg(outcomeId)],
        }),
      ),
    [send],
  );

  /** Settle a proposal whose window closed unchallenged. Anyone may do this; we just make it easy. */
  const finalize = React.useCallback(
    (target: MarketTarget) =>
      send(
        target.resolver as Hex,
        encodeFunctionData({
          abi: RESOLVER_ABI,
          functionName: 'finalize',
          args: [target.market as Hex, target.marketId],
        }),
      ),
    [send],
  );

  /**
   * Rule on a market through the quorum.
   *
   * Raises the call if nobody has, and confirms it if somebody already did. Doing both from one
   * button is deliberate: the quorum keys proposals by their contents, so two signers who decide
   * the same thing independently land on one proposal rather than deadlocking at one confirmation
   * each — but only if the second one confirms instead of trying to raise it again.
   *
   * At a threshold of one this executes inside the raise, which is the phase-1 case.
   */
  const arbitrate = React.useCallback(
    async (
      target: MarketTarget & { multisig: string },
      outcomeId: number | null,
    ): Promise<OperatorResult> => {
      const inner = encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: 'arbitrate',
        args: [target.market as Hex, target.marketId, outcomeArg(outcomeId)],
      });

      let pending: readonly [boolean, bigint] = [false, 0n];
      try {
        pending = (await publicClient().readContract({
          address: target.multisig as Hex,
          abi: MULTISIG_ABI,
          functionName: 'pendingProposal',
          args: [target.resolver as Hex, inner],
        })) as readonly [boolean, bigint];
      } catch {
        // A read failure is not a reason to refuse: fall through and raise it. The worst case is a
        // revert that the simulation catches before anything is sent.
      }

      const data = pending[0]
        ? encodeFunctionData({ abi: MULTISIG_ABI, functionName: 'confirm', args: [pending[1]] })
        : encodeFunctionData({
            abi: MULTISIG_ABI,
            functionName: 'propose',
            args: [target.resolver as Hex, inner],
          });

      return send(target.multisig as Hex, data);
    },
    [send],
  );

  return { propose, finalize, arbitrate, busy };
}
