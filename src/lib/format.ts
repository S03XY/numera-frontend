/**
 * Formatting for on-chain values.
 *
 * RULE: every amount from the API is a base-unit integer STRING that can exceed
 * Number.MAX_SAFE_INTEGER. Always parse with BigInt. `Number(...)` on a uint256
 * silently loses precision — that is a money bug, so it never appears here.
 */

const WAD = 10n ** 18n;

/** Parse a decimal integer string to bigint. Returns null on anything invalid. */
export function toBigInt(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^-?\d+$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

/**
 * Base units → human decimal string, without floating point.
 * e.g. formatUnits('1500000', 6) === '1.5'
 */
export function formatUnits(value: string | bigint | null | undefined, decimals: number): string | null {
  const raw = typeof value === 'bigint' ? value : toBigInt(value ?? null);
  if (raw === null) return null;
  if (decimals === 0) return raw.toString();

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  let out = whole.toString();
  if (frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    out = `${out}.${fracStr}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * Currency display with thousands separators and fixed decimals.
 *
 * Trailing zeros are dropped by default, which is right for a balance read at a glance — "$7"
 * beats "$7.00" in a column of them. `minFractionDigits` opts back in where the cents are the
 * point: a share price of "$0.6" reads as an unfinished number rather than sixty cents.
 */
export function formatAmount(
  value: string | bigint | null | undefined,
  decimals: number,
  opts: { minFractionDigits?: number; maxFractionDigits?: number; compact?: boolean } = {},
): string {
  const human = formatUnits(value, decimals);
  if (human === null) return '—';
  const n = Number(human); // safe: display-only, after scaling down
  if (!Number.isFinite(n)) return human;
  const min = opts.minFractionDigits ?? 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: min,
    // Never below the minimum, or Intl throws rather than formatting.
    maximumFractionDigits: Math.max(min, opts.maxFractionDigits ?? 2),
    notation: opts.compact ? 'compact' : 'standard',
  }).format(n);
}

/** USDC-style money string, e.g. "$1,234.56". */
export function formatUsd(
  value: string | bigint | null | undefined,
  decimals: number,
  opts: { compact?: boolean; cents?: boolean } = {},
): string {
  const formatted = formatAmount(value, decimals, {
    // Cents shown on request: a figure being committed to — a price, a bill, a cap — is read
    // digit by digit, and there "$9.9" invites a second look that "$9.90" does not.
    minFractionDigits: opts.cents ? 2 : 0,
    maxFractionDigits: 2,
    compact: opts.compact,
  });
  return formatted === '—' ? '—' : `$${formatted}`;
}

/**
 * A signed money delta: `+$12.00`, `-$12.00`, `$0`.
 *
 * The sign belongs before the currency symbol, not between it and the digits. Formatting a
 * negative through {@link formatUsd} gives `$-12.00` — which every screen showing a loss was
 * doing. At a glance the minus reads as part of the symbol rather than as a loss.
 */
export function formatSignedUsd(
  value: string | bigint | null | undefined,
  decimals: number,
): string {
  const raw = typeof value === 'bigint' ? value : toBigInt(value ?? null);
  if (raw === null) return '—';
  if (raw === 0n) return formatUsd(0n, decimals);
  return `${raw < 0n ? '-' : '+'}${formatUsd(raw < 0n ? -raw : raw, decimals)}`;
}

/**
 * WAD (1e18) fixed-point price → percentage number in [0,100].
 * Rounds half-up at the requested precision using integer math.
 */
export function wadToPercent(value: string | bigint | null | undefined, dp = 1): number | null {
  const raw = typeof value === 'bigint' ? value : toBigInt(value ?? null);
  if (raw === null) return null;
  const scale = 10n ** BigInt(dp);
  // percent = raw / 1e18 * 100, scaled by 10^dp, rounded half-up
  const numerator = raw * 100n * scale * 2n + WAD;
  const rounded = numerator / (WAD * 2n);
  return Number(rounded) / Number(scale);
}

/** Display string for a probability, e.g. "62.5%". */
export function formatPercent(value: string | bigint | null | undefined, dp = 1): string {
  const pct = wadToPercent(value, dp);
  return pct === null ? '—' : `${pct.toFixed(dp)}%`;
}

/** Basis points → percent string, e.g. 200 → "2%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * Compact relative time until/since an ISO timestamp.
 * Future → "in 3h 20m"; past → "2d ago".
 */
export function formatTimeUntil(iso: string, now: number = Date.now()): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '—';
  const diffMs = target - now;
  const past = diffMs < 0;
  let s = Math.floor(Math.abs(diffMs) / 1000);

  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);

  let label: string;
  if (d > 0) label = h > 0 ? `${d}d ${h}h` : `${d}d`;
  else if (h > 0) label = m > 0 ? `${h}h ${m}m` : `${h}h`;
  else if (m > 0) label = `${m}m`;
  else label = '<1m';

  return past ? `${label} ago` : `in ${label}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

/**
 * Parse a human decimal string ("12.50") into base units.
 *
 * Returns `null` for anything that is not a clean decimal, **including a value
 * with more precision than the token has**. Truncating a user's extra digit
 * silently changes the amount they agreed to, which is a money bug; refusing it
 * lets the UI say so instead.
 *
 * Deliberately not viem's `parseUnits`, which truncates excess precision.
 */
export function parseDecimalAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  return (
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  );
}

/**
 * MON to four decimal places, for gas balances.
 *
 * Four rather than two because the useful question about a gas balance is "is it non-zero", and
 * an account holding 0.0002 MON can still pay for a transaction. Truncating that to "0.00 MON"
 * sends somebody to a faucet they do not need.
 */
export function formatMon(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${whole}.${frac} MON`;
}
