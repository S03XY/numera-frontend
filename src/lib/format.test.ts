import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatBps,
  formatDateTime,
  formatMon,
  formatPercent,
  formatSignedUsd,
  formatTimeUntil,
  formatUnits,
  formatUsd,
  toBigInt,
  wadToPercent,
} from './format';

describe('toBigInt', () => {
  it('parses integer strings (positive)', () => {
    expect(toBigInt('1500000')).toBe(1500000n);
    expect(toBigInt('0')).toBe(0n);
    expect(toBigInt('-42')).toBe(-42n);
  });

  it('parses a full uint256 without precision loss (regression)', () => {
    const max = (2n ** 256n - 1n).toString();
    expect(toBigInt(max)).toBe(2n ** 256n - 1n);
  });

  it('rejects malformed input (negative)', () => {
    expect(toBigInt('12.5')).toBeNull();
    expect(toBigInt('abc')).toBeNull();
    expect(toBigInt('1e18')).toBeNull(); // exponential must never be accepted
    expect(toBigInt('')).toBeNull();
    expect(toBigInt(null)).toBeNull();
    expect(toBigInt(undefined)).toBeNull();
  });
});

describe('formatUnits', () => {
  it('scales base units by decimals (positive)', () => {
    expect(formatUnits('1500000', 6)).toBe('1.5');
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0');
  });

  it('handles 0 decimals and negatives', () => {
    expect(formatUnits('123', 0)).toBe('123');
    expect(formatUnits('-1500000', 6)).toBe('-1.5');
  });

  it('does not lose precision on huge values (regression — the money bug)', () => {
    // 1e30 base units at 18 decimals = 1,000,000,000,000 exactly.
    expect(formatUnits('1' + '0'.repeat(30), 18)).toBe('1000000000000');
    // A value far beyond Number.MAX_SAFE_INTEGER must survive exactly.
    expect(formatUnits('123456789012345678901234567890', 18)).toBe(
      '123456789012.34567890123456789',
    );
  });

  it('strips trailing zeros but keeps significant digits', () => {
    expect(formatUnits('1230000', 6)).toBe('1.23');
    expect(formatUnits('1000001', 6)).toBe('1.000001');
  });

  it('returns null for invalid input (negative)', () => {
    expect(formatUnits('nope', 6)).toBeNull();
    expect(formatUnits(null, 6)).toBeNull();
  });
});

describe('formatAmount / formatUsd', () => {
  it('adds thousands separators (positive)', () => {
    expect(formatAmount('1234560000', 6)).toBe('1,234.56');
    expect(formatUsd('1234560000', 6)).toBe('$1,234.56');
  });

  it('supports compact notation', () => {
    expect(formatAmount('1500000000000', 6, { compact: true })).toBe('1.5M');
  });

  it('renders an em dash for missing values (negative)', () => {
    expect(formatAmount(null, 6)).toBe('—');
    expect(formatUsd('garbage', 6)).toBe('—');
  });
});

describe('wadToPercent / formatPercent', () => {
  it('converts WAD prices to percentages (positive)', () => {
    expect(wadToPercent('500000000000000000')).toBe(50);
    expect(wadToPercent('1000000000000000000')).toBe(100);
    expect(wadToPercent('0')).toBe(0);
    expect(wadToPercent('625000000000000000')).toBe(62.5);
  });

  it('rounds half-up at the requested precision', () => {
    // 0.3333... -> 33.3
    expect(wadToPercent('333333333333333333')).toBe(33.3);
    // 0.66666... -> 66.7 (rounds up)
    expect(wadToPercent('666666666666666666')).toBe(66.7);
  });

  it('formats with a percent sign', () => {
    expect(formatPercent('500000000000000000')).toBe('50.0%');
    expect(formatPercent('625000000000000000', 2)).toBe('62.50%');
  });

  it('returns null/em dash for invalid input (negative)', () => {
    expect(wadToPercent(null)).toBeNull();
    expect(formatPercent('bad')).toBe('—');
  });

  it('keeps a 3-outcome price vector summing to ~100% (regression)', () => {
    const third = (10n ** 18n / 3n).toString();
    const sum = 2 * wadToPercent(third, 4)! + wadToPercent((10n ** 18n - 2n * (10n ** 18n / 3n)).toString(), 4)!;
    expect(sum).toBeCloseTo(100, 2);
  });
});

describe('formatBps', () => {
  it('formats whole and fractional percents', () => {
    expect(formatBps(200)).toBe('2%');
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(250)).toBe('2.50%');
    expect(formatBps(0)).toBe('0%');
  });
});

describe('formatTimeUntil', () => {
  const now = new Date('2026-01-01T00:00:00Z').getTime();
  const iso = (ms: number) => new Date(now + ms).toISOString();

  it('formats future times (positive)', () => {
    expect(formatTimeUntil(iso(3 * 3600_000 + 20 * 60_000), now)).toBe('in 3h 20m');
    expect(formatTimeUntil(iso(45 * 60_000), now)).toBe('in 45m');
    expect(formatTimeUntil(iso(2 * 86400_000), now)).toBe('in 2d');
  });

  it('formats past times', () => {
    expect(formatTimeUntil(iso(-2 * 86400_000), now)).toBe('2d ago');
    expect(formatTimeUntil(iso(-30 * 60_000), now)).toBe('30m ago');
  });

  it('collapses sub-minute differences', () => {
    expect(formatTimeUntil(iso(5_000), now)).toBe('in <1m');
  });

  it('returns em dash for an invalid date (negative)', () => {
    expect(formatTimeUntil('not-a-date', now)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats a valid ISO timestamp', () => {
    expect(formatDateTime('2026-01-01T00:00:00Z')).toMatch(/2025|2026/);
  });

  it('returns em dash for invalid input (negative)', () => {
    expect(formatDateTime('nope')).toBe('—');
  });
});

describe('formatSignedUsd', () => {
  it('puts the sign before the currency symbol, never inside it (REGRESSION)', () => {
    // `$-12` reads as a currency called "$-" before it reads as a loss, and at a glance the minus
    // disappears into the symbol. Every screen showing a negative P&L was doing this.
    expect(formatSignedUsd(-12_000_000n, 6)).toBe('-$12');
    expect(formatSignedUsd(-12_000_000n, 6)).not.toBe('$-12');
  });

  it('marks a gain explicitly (positive)', () => {
    expect(formatSignedUsd(12_500_000n, 6)).toBe('+$12.5');
  });

  it('leaves a flat position unsigned (negative)', () => {
    // "+$0" claims a gain that did not happen.
    expect(formatSignedUsd(0n, 6)).toBe('$0');
  });

  it('accepts the decimal strings the API actually returns (positive)', () => {
    expect(formatSignedUsd('-2500000', 6)).toBe('-$2.5');
    expect(formatSignedUsd('2500000', 6)).toBe('+$2.5');
  });

  it('has no answer for a missing figure rather than inventing zero (negative)', () => {
    expect(formatSignedUsd(null, 6)).toBe('—');
    expect(formatSignedUsd(undefined, 6)).toBe('—');
  });
});

describe('formatMon', () => {
  it('renders whole and fractional MON (positive)', () => {
    expect(formatMon(10n ** 18n)).toBe('1.0000 MON');
    expect(formatMon(1_500_000_000_000_000_000n)).toBe('1.5000 MON');
  });

  it('shows a dust balance as non-zero (regression)', () => {
    // Truncating to 2dp would print "0.00 MON" for an account that can in fact
    // pay for a transaction, sending the user to a faucet they do not need.
    expect(formatMon(2_000_000_000_000_00n)).toBe('0.0002 MON');
  });

  it('pads the fraction so digits do not shift (negative)', () => {
    expect(formatMon(1_000_000_000_000_00n)).toBe('0.0001 MON');
    expect(formatMon(0n)).toBe('0.0000 MON');
  });
});
