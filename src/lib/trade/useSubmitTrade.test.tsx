import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSubmitTrade } from './useSubmitTrade';
import { makeMarket } from '@/test/render';
import { usePool } from '@/lib/pool/PoolProvider';
import { useExecution } from '@/lib/execution/useExecution';
import { openPosition, closePosition } from '@/lib/execution/trading';
import { ExecutionError } from '@/lib/execution/market-account';

vi.mock('@/lib/pool/PoolProvider', () => ({ usePool: vi.fn() }));
vi.mock('@/lib/execution/useExecution', () => ({
  useExecution: vi.fn(),
  executionUnavailableReason: () => null,
}));
/**
 * The relay's state, stubbed. It is a react-query hook against a live endpoint, and this suite
 * renders bare hooks with no provider — but the reason to stub it is that `paused` is one of the
 * gates under test, not that wiring a client would be inconvenient.
 */
const relay = { available: true, reason: null as string | null, resolution: true, unknown: false };
vi.mock('@/lib/relay/useRelayStatus', () => ({ useRelayStatus: () => relay }));
vi.mock('@/lib/execution/trading', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/execution/trading')>()),
  openPosition: vi.fn(),
  closePosition: vi.fn(),
}));

const mockUseUnlink = usePool as unknown as ReturnType<typeof vi.fn>;
const mockUseExecution = useExecution as unknown as ReturnType<typeof vi.fn>;
const open = openPosition as unknown as ReturnType<typeof vi.fn>;
const close = closePosition as unknown as ReturnType<typeof vi.fn>;

const CONTEXT = { marketRef: 'stale', engine: '0xstale', token: '0xstale' };
const RESULT = { hash: '0xtx', account: '0xea', withdrawn: 0n };

const lmsr = makeMarket({
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  engine: 'LS_LMSR',
  address: '0xmarket',
  marketId: '7',
  collateral: '0xusdc',
});

function setup(status = 'ready', context: unknown = CONTEXT) {
  mockUseUnlink.mockReturnValue({ status, unlock: vi.fn() });
  mockUseExecution.mockReturnValue(context);
  return renderHook(() => useSubmitTrade(lmsr)).result;
}

beforeEach(() => {
  vi.clearAllMocks();
  relay.available = true;
  relay.reason = null;
  open.mockResolvedValue(RESULT);
  close.mockResolvedValue(RESULT);
});

describe('useSubmitTrade — buying', () => {
  it('opens a position with the on-chain ids and slippage ceiling (positive)', async () => {
    const { current } = setup();
    const res = await current.submit({
      market: lmsr,
      outcomeIndex: 1,
      side: 'buy',
      size: 500_000n,
      guard: 260_000n,
    });

    expect(res).toEqual({ ok: true, txHash: '0xtx', account: '0xea', change: 'pending' });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ marketRef: lmsr.id, engine: '0xmarket', token: '0xusdc' }),
      expect.objectContaining({
        marketId: 7n,
        outcomeId: 1n,
        sharesOut: 500_000n,
        maxCost: 260_000n,
      }),
    );
  });

  it('opens a short via buyComplement rather than buy (positive)', async () => {
    const { current } = setup();
    await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'short',
      size: 100n,
      guard: 200n,
    });
    expect(open.mock.calls[0][1]).toMatchObject({ complement: true });
  });

  it('parses a uint256-scale market id without precision loss (regression)', async () => {
    // `Number` would round this; a rounded market id trades on the wrong book.
    const huge = makeMarket({ ...lmsr, marketId: '123456789012345678901234567890' });
    const { current } = setup();
    await current.submit({
      market: huge,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });
    expect(open.mock.calls[0][1].marketId).toBe(123456789012345678901234567890n);
  });

  it('binds the context to the market being traded (REGRESSION)', async () => {
    // The hook is built from whichever market was passed at render. Signing a request against one
    // market's derived account for another market's trade would put the position somewhere the
    // trader cannot find or claim it.
    const { current } = setup();
    await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });

    const ctx = open.mock.calls[0][0];
    expect(ctx.marketRef).toBe(lmsr.id);
    expect(ctx.engine).toBe(lmsr.address);
    expect(ctx.token).toBe(lmsr.collateral);
  });
});

describe('useSubmitTrade — selling', () => {
  it('closes a position with the slippage floor (positive)', async () => {
    const { current } = setup();
    await current.submit({
      market: lmsr,
      outcomeIndex: 1,
      side: 'sell',
      size: 250_000n,
      guard: 120_000n,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0][1]).toMatchObject({ sharesIn: 250_000n, minRefund: 120_000n });
  });

  it('closes a short as one atomic basket sale (REGRESSION)', async () => {
    // Separate leg sales would be a separate relayed transaction each, and a revert partway
    // through leaves the trader holding an unbalanced remainder that is no longer a hedge.
    const { current } = setup();
    await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'sell',
      complement: true,
      size: 100n,
      guard: 50n,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0][1]).toMatchObject({ complement: true });
  });
});

describe('useSubmitTrade — failure modes', () => {
  it('reports a locked session rather than an error (positive)', async () => {
    // Not unlocked yet is a normal state. Showing it as a failure sends the user looking for a
    // problem with their bet.
    const { current } = setup('locked', null);
    expect(await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    })).toEqual({ ok: false, reason: 'locked' });
    expect(open).not.toHaveBeenCalled();
  });

  it('does not report a rejected trade as something else (REGRESSION)', async () => {
    open.mockRejectedValue(
      new ExecutionError('Your bet was rejected by the market.', { code: 'rejected' }),
    );
    const { current } = setup();
    const res = await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });

    expect(res).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('keeps a timed-out trade distinguishable from a rejected one (REGRESSION)', async () => {
    // `pending` means the transaction is on the wire. Calling it a failure is what makes someone
    // bet twice.
    open.mockRejectedValue(
      new ExecutionError('submitted and has not settled yet', { code: 'pending' }),
    );
    const { current } = setup();
    const res = await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });

    expect(res).toMatchObject({ ok: false, reason: 'pending' });
  });

  it('reports a pool failure as temporarily unavailable, not the user’s fault (negative)', async () => {
    open.mockRejectedValue(
      new ExecutionError('private balance is untouched', { code: 'pool' }),
    );
    const { current } = setup();
    const res = await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });

    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('reports an unexpected failure without throwing at the caller (negative)', async () => {
    open.mockRejectedValue(new Error('boom'));
    const { current } = setup();
    const res = await current.submit({
      market: lmsr,
      outcomeIndex: 0,
      side: 'buy',
      size: 1n,
      guard: 1n,
    });

    expect(res).toMatchObject({ ok: false, reason: 'failed', message: 'boom' });
  });
});

describe('useSubmitTrade — gating', () => {
  it.each([
    ['locked', true, false],
    ['error', true, false],
    ['ready', false, false],
    ['unlocking', false, false],
  ])('status %s → needsUnlock=%s unavailable=%s', (status, needsUnlock, unavailable) => {
    const { current } = setup(status);
    expect(current.needsUnlock).toBe(needsUnlock);
    expect(current.unavailable).toBe(unavailable);
  });

  it('reports unavailable when the deployment has no privacy layer (negative)', () => {
    // Distinct from locked: inviting someone to unlock into something that cannot trade wastes a
    // passkey prompt and reads as a bug.
    const { current } = setup('unavailable', null);
    expect(current.unavailable).toBe(true);
  });
});

/**
 * Whether a bet can be placed at all, asked before the press.
 *
 * Numera pays the network fee on every bet, so a relayer that is out of budget stops betting for
 * everybody. Before this the first a trader knew of it was a failure after signing and waiting.
 */
describe('useSubmitTrade — sponsored gas', () => {
  it('reports the pause and its cause, without claiming the deployment is broken (positive)', () => {
    relay.available = false;
    relay.reason = 'capped';

    const { current } = setup();

    expect(current.paused).toBe('capped');
    // Distinct from `unavailable`, which is a standing fact about the deployment. A spent budget
    // resolves itself overnight and must not be described as a missing privacy layer.
    expect(current.unavailable).toBe(false);
  });

  it('stays quiet while the relayer is fine (negative)', () => {
    expect(setup().current.paused).toBeNull();
  });

  it('assumes the relayer is fine when the status is unknown (REGRESSION)', () => {
    // `useRelayStatus` fails open, and this is the consequence that matters: a failed GET must not
    // take betting down across the whole site. One trade that fails has copy already written.
    relay.available = true;
    relay.reason = null;

    expect(setup().current.paused).toBeNull();
  });
});
