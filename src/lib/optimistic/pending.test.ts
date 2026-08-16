import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPending,
  balanceSubject,
  pendingBalances,
  pendingPositions,
  positionSubject,
} from './pending';
import { predictClaim, predictTrade, predictTransfer } from './predict';

/**
 * Predictions, and the two ways they are allowed to end.
 *
 * A prediction that never retires is a number on screen that nothing will ever correct, and a
 * prediction that retires too early is a flicker: the position appears, the next poll returns data
 * from before the indexer caught up, and it vanishes and comes back. Both are worse than the wait
 * they replace, so the retirement rule is what most of this file is about.
 */

const ACCOUNT = '0xAaAa111111111111111111111111111111111111';
const MARKET = '11111111-1111-4111-8111-111111111111';
const TOKEN = '0xcccc111111111111111111111111111111111111';

beforeEach(() => {
  pendingPositions.clear();
  pendingBalances.clear();
});

describe('the store', () => {
  it('holds a prediction until the server figure moves (positive)', () => {
    pendingPositions.add({ subject: 'position:a:m:0', delta: 5n, witness: 10n });

    // The server still reports what it did when the prediction was made, so it has not seen the
    // trade. Retiring here is exactly the flicker this design exists to avoid.
    pendingPositions.reconcile(() => 10n);
    expect(pendingPositions.snapshot()).toHaveLength(1);

    // Any movement at all is the signal. Not equality with the prediction: prices move between
    // quoting and settling, so the figure that arrives is rarely the figure that was predicted.
    pendingPositions.reconcile(() => 14n);
    expect(pendingPositions.snapshot()).toHaveLength(0);
  });

  it('holds a prediction the server has no row for at all (regression)', () => {
    // A first bet on an outcome. `undefined` means "not in the response", which is the case this
    // whole module exists for — reading it as confirmation would retire the effect immediately.
    pendingPositions.add({ subject: 'position:a:m:0', delta: 5n, witness: 0n });
    pendingPositions.reconcile(() => undefined);
    expect(pendingPositions.snapshot()).toHaveLength(1);
  });

  it('takes a prediction back on demand (positive)', () => {
    const revert = pendingPositions.add({ subject: 'position:a:m:0', delta: 5n, witness: 0n });
    revert();
    expect(pendingPositions.snapshot()).toHaveLength(0);
  });

  it('ignores a second revert rather than dropping somebody else (negative)', () => {
    const revert = pendingPositions.add({ subject: 'position:a:m:0', delta: 5n, witness: 0n });
    pendingPositions.add({ subject: 'position:a:m:1', delta: 3n, witness: 0n });

    revert();
    revert();

    expect(pendingPositions.snapshot()).toHaveLength(1);
  });

  it('keeps a stable snapshot when nothing changed (regression)', () => {
    pendingPositions.add({ subject: 'position:a:m:0', delta: 5n, witness: 10n });
    const before = pendingPositions.snapshot();

    pendingPositions.reconcile(() => 10n);

    // `useSyncExternalStore` re-renders on every new reference. A reconcile that rebuilt the array
    // each poll would re-render every position panel four times a second, forever.
    expect(pendingPositions.snapshot()).toBe(before);
  });
});

describe('applyPending', () => {
  it('sums several predictions on one subject (positive)', () => {
    const entries = [
      { id: 1, subject: 's', delta: 5n, secondary: 2n, collected: false, witness: 0n, createdAt: 0 },
      { id: 2, subject: 's', delta: 3n, secondary: 1n, collected: false, witness: 0n, createdAt: 0 },
    ];
    expect(applyPending(entries, { value: 10n })).toMatchObject({ value: 18n, secondary: 3n });
  });

  it('never renders a negative holding (negative)', () => {
    // A sale predicted against a figure the server has since revised down. Below zero is not a
    // thing a position can be, and drawing "-4 shares" reads as a bug in the product.
    const entries = [
      { id: 1, subject: 's', delta: -20n, secondary: 0n, collected: false, witness: 0n, createdAt: 0 },
    ];
    expect(applyPending(entries, { value: 10n }).value).toBe(0n);
  });
});

describe('predictTrade', () => {
  const base = {
    account: ACCOUNT,
    marketRef: MARKET,
    token: TOKEN,
    balance: 100_000_000n,
    shares: 10_000_000n,
    money: 6_000_000n,
    held: new Map<number, bigint>(),
    basis: 0n,
  };

  it('adds shares and takes the stake out of the balance on a buy (positive)', () => {
    predictTrade({ ...base, legs: [0], side: 'buy' });

    const position = pendingPositions
      .snapshot()
      .find((e) => e.subject === positionSubject(ACCOUNT, MARKET, 0));
    expect(position?.delta).toBe(10_000_000n);
    expect(position?.secondary).toBe(6_000_000n);

    const balance = pendingBalances
      .snapshot()
      .find((e) => e.subject === balanceSubject(ACCOUNT, TOKEN));
    expect(balance?.delta).toBe(-6_000_000n);
  });

  it('spreads a NO across every other outcome (regression)', () => {
    // A NO is not an outcome. It is one share of each of the others, and a prediction that drew it
    // on the named row would put the position on the wrong side of the market.
    predictTrade({ ...base, legs: [1, 2], side: 'buy' });

    const legs = pendingPositions.snapshot().filter((e) => e.subject.startsWith('position:'));
    expect(legs).toHaveLength(2);
    expect(legs.every((e) => e.delta === 10_000_000n)).toBe(true);
    // The parts add back up to the money that actually moved, rather than to a rounded-down
    // approximation of it.
    expect(legs.reduce((sum, e) => sum + e.secondary, 0n)).toBe(6_000_000n);
  });

  it('returns shares and pays the proceeds in on a sale (positive)', () => {
    predictTrade({
      ...base,
      legs: [0],
      side: 'sell',
      held: new Map([[0, 20_000_000n]]),
      basis: 8_000_000n,
    });

    const position = pendingPositions.snapshot()[0];
    expect(position.delta).toBe(-10_000_000n);
    // Half the position sold releases half the basis.
    expect(position.secondary).toBe(-4_000_000n);
    expect(pendingBalances.snapshot()[0].delta).toBe(6_000_000n);
  });

  it('witnesses each leg on its own confirmed figure (regression)', () => {
    // Each row retires when *its* figure moves. Sharing one witness would keep a settled leg on
    // screen because a different leg had not landed yet.
    predictTrade({
      ...base,
      legs: [0, 1],
      side: 'buy',
      held: new Map([
        [0, 3n],
        [1, 7n],
      ]),
    });

    expect(pendingPositions.snapshot().map((e) => e.witness)).toEqual([3n, 7n]);
  });

  it('predicts nothing while the session is locked (negative)', () => {
    predictTrade({ ...base, account: null, legs: [0], side: 'buy' });
    expect(pendingPositions.snapshot()).toHaveLength(0);
    expect(pendingBalances.snapshot()).toHaveLength(0);
  });

  it('predicts nothing for a size that was never solved (negative)', () => {
    predictTrade({ ...base, shares: null, legs: [0], side: 'buy' });
    expect(pendingPositions.snapshot()).toHaveLength(0);
  });

  it('takes back every leg and the balance together (positive)', () => {
    const revert = predictTrade({ ...base, legs: [0, 1], side: 'buy' });
    revert();
    expect(pendingPositions.snapshot()).toHaveLength(0);
    expect(pendingBalances.snapshot()).toHaveLength(0);
  });
});

describe('predictTransfer', () => {
  it('moves the balance both ways (positive)', () => {
    predictTransfer({ account: ACCOUNT, token: TOKEN, balance: 0n, delta: 5_000_000n });
    expect(pendingBalances.snapshot()[0].delta).toBe(5_000_000n);

    pendingBalances.clear();
    predictTransfer({ account: ACCOUNT, token: TOKEN, balance: 5_000_000n, delta: -5_000_000n });
    expect(pendingBalances.snapshot()[0].delta).toBe(-5_000_000n);
  });

  it('predicts nothing for a zero transfer (negative)', () => {
    predictTransfer({ account: ACCOUNT, token: TOKEN, balance: 0n, delta: 0n });
    expect(pendingBalances.snapshot()).toHaveLength(0);
  });
});

describe('predictClaim', () => {
  it('flips the line without removing the shares (regression)', () => {
    predictClaim({ account: ACCOUNT, marketRef: MARKET, outcomeIndex: 0, shares: 9n });

    const entry = pendingBalances.snapshot().concat(pendingPositions.snapshot())[0];
    // `redeem` marks a position paid; it does not delete it. Predicting a disappearance would be
    // undone at the next poll, which is a worse lie than the wait.
    expect(entry.collected).toBe(true);
    expect(entry.delta).toBe(0n);
    expect(entry.witness).toBe(9n);
  });
});
