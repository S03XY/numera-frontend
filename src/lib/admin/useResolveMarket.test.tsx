import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { decodeFunctionData, parseAbi } from 'viem';
import { useOperatorResolution, INVALID_OUTCOME } from './useResolveMarket';

/**
 * The operator's three moves.
 *
 * Two of them move every trader's money at once, so what matters here is that the transaction says
 * exactly what the operator chose, that it goes to the right contract, and that nothing is sent
 * when the chain would reject it.
 *
 * The third — arbitration — is routed through a quorum, and the property under test is that the
 * same decision from two signers converges on one proposal rather than deadlocking at one
 * confirmation each.
 */

const RESOLVER = '0x2222222222222222222222222222222222222222';
const MULTISIG = '0x5555555555555555555555555555555555555555';
const ENGINE = '0x3333333333333333333333333333333333333333';
const SIGNER = '0x4444444444444444444444444444444444444444';

const RESOLVER_ABI = parseAbi([
  'function propose(address market, uint256 marketId, uint256 outcomeId)',
  'function finalize(address market, uint256 marketId)',
  'function arbitrate(address market, uint256 marketId, uint256 trueOutcomeId)',
]);
const MULTISIG_ABI = parseAbi([
  'function propose(address target, bytes data) returns (uint256)',
  'function confirm(uint256 id)',
]);

type SentTx = { to: `0x${string}`; data: `0x${string}` };
const sendTransaction = vi.fn(async (_tx: SentTx) => '0xtxhash');
const call = vi.fn(async () => ({ data: '0x' }));
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' }));
const readContract = vi.fn(async () => [false, 0n] as readonly [boolean, bigint]);

vi.mock('@/lib/wallet/reconnect', () => ({
  reconnectWallet: vi.fn(async () => ({ address: SIGNER, disconnect: vi.fn() })),
}));

/*
  The hook pins the signer to the signed-in address now.

  Operator actions are sent from the operator's own wallet and authorised by an on-chain role, so a
  MetaMask that has switched accounts since sign-in holds a different role, or none — and the revert
  that follows names the contract rather than the cause. `reconnectWallet` refuses instead, and this
  is the address it checks against.
*/
vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => ({ user: { address: SIGNER } }),
}));

vi.mock('@/lib/chain/evm', () => ({
  monadTestnet: { id: 10143 },
  publicClient: () => ({ call, waitForTransactionReceipt, readContract }),
  signerWalletClient: async () => ({ account: { address: SIGNER }, sendTransaction }),
}));

const TARGET = { resolver: RESOLVER, market: ENGINE, marketId: 7n };

function sent(): SentTx {
  return sendTransaction.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  readContract.mockResolvedValue([false, 0n]);
});

describe('useOperatorResolution', () => {
  // ------------------------------------------------------------- proposing

  it('proposes straight to the resolver (positive)', async () => {
    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.propose(TARGET, 1);

    expect(outcome).toMatchObject({ ok: true, txHash: '0xtxhash' });
    expect(sent().to).toBe(RESOLVER);
    expect(decodeFunctionData({ abi: RESOLVER_ABI, data: sent().data })).toMatchObject({
      functionName: 'propose',
      args: [ENGINE, 7n, 1n],
    });
  });

  /** Outcome 0 is falsy. Treating it as "void" would settle the wrong way round. */
  it('proposes outcome zero rather than voiding (regression)', async () => {
    const { result } = renderHook(() => useOperatorResolution());
    await result.current.propose(TARGET, 0);

    expect(decodeFunctionData({ abi: RESOLVER_ABI, data: sent().data })).toMatchObject({
      functionName: 'propose',
      args: [ENGINE, 7n, 0n],
    });
  });

  it('proposes a void with the sentinel rather than an index', async () => {
    const { result } = renderHook(() => useOperatorResolution());
    await result.current.propose(TARGET, null);

    expect(decodeFunctionData({ abi: RESOLVER_ABI, data: sent().data })).toMatchObject({
      functionName: 'propose',
      args: [ENGINE, 7n, INVALID_OUTCOME],
    });
  });

  // ------------------------------------------------------------ finalizing

  it('finalizes an unchallenged proposal', async () => {
    const { result } = renderHook(() => useOperatorResolution());
    await result.current.finalize(TARGET);

    expect(sent().to).toBe(RESOLVER);
    expect(decodeFunctionData({ abi: RESOLVER_ABI, data: sent().data })).toMatchObject({
      functionName: 'finalize',
      args: [ENGINE, 7n],
    });
  });

  // ----------------------------------------------------------- arbitrating

  it('raises the ruling with the quorum, not with the resolver (positive)', async () => {
    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.arbitrate({ ...TARGET, multisig: MULTISIG }, 1);

    expect(outcome).toMatchObject({ ok: true });
    // Sent to the multisig — a direct call to the resolver would revert, because the operator's own
    // wallet deliberately does not hold ARBITRATOR_ROLE.
    expect(sent().to).toBe(MULTISIG);

    const outer = decodeFunctionData({ abi: MULTISIG_ABI, data: sent().data });
    expect(outer.functionName).toBe('propose');
    expect(outer.args?.[0]).toBe(RESOLVER);
    expect(
      decodeFunctionData({ abi: RESOLVER_ABI, data: outer.args?.[1] as `0x${string}` }),
    ).toMatchObject({ functionName: 'arbitrate', args: [ENGINE, 7n, 1n] });
  });

  /**
   * The convergence property. Two signers who decide the same thing independently must land on one
   * proposal; a second `propose` would revert, and the ruling would sit at one confirmation forever.
   */
  it('confirms an existing proposal instead of raising a second one (regression)', async () => {
    readContract.mockResolvedValue([true, 42n]);

    const { result } = renderHook(() => useOperatorResolution());
    await result.current.arbitrate({ ...TARGET, multisig: MULTISIG }, 1);

    expect(sent().to).toBe(MULTISIG);
    expect(decodeFunctionData({ abi: MULTISIG_ABI, data: sent().data })).toMatchObject({
      functionName: 'confirm',
      args: [42n],
    });
  });

  /** A read failure must not block a ruling: fall through and raise it, and let simulation decide. */
  it('still raises the ruling when the quorum cannot be read (negative)', async () => {
    readContract.mockRejectedValue(new Error('rpc down'));

    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.arbitrate({ ...TARGET, multisig: MULTISIG }, 0);

    expect(outcome).toMatchObject({ ok: true });
    expect(decodeFunctionData({ abi: MULTISIG_ABI, data: sent().data }).functionName).toBe('propose');
  });

  // -------------------------------------------------------------- refusals

  it('never sends a transaction when the simulation reverts (negative)', async () => {
    call.mockRejectedValueOnce(new Error('MarketNotClosed'));

    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.propose(TARGET, 1);

    expect(outcome).toMatchObject({ ok: false, reason: 'not-closed' });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('names a missing role rather than reporting a generic failure (negative)', async () => {
    call.mockRejectedValueOnce(new Error('AccessControlUnauthorizedAccount'));

    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.propose(TARGET, 1);

    expect(outcome).toMatchObject({ ok: false, reason: 'not-authorised' });
  });

  it('distinguishes an open challenge window from a generic failure (negative)', async () => {
    call.mockRejectedValueOnce(new Error('DisputeWindowOpen'));

    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.finalize(TARGET);

    expect(outcome).toMatchObject({ ok: false, reason: 'window-open' });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('reports an existing proposal as already handled rather than as an error', async () => {
    call.mockRejectedValueOnce(new Error('ProposalExists'));

    const { result } = renderHook(() => useOperatorResolution());
    const outcome = await result.current.propose(TARGET, 1);

    expect(outcome).toMatchObject({ ok: false, reason: 'already-settled' });
  });
});
