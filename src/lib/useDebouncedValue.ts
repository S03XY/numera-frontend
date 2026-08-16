'use client';

import * as React from 'react';

/**
 * The value, held still until it stops changing.
 *
 * Used for the one input that costs money to react to: sizing a bet by budget means solving the
 * cost curve against the chain, so every keystroke of "50" would otherwise fire a fresh round of
 * `eth_call`s for a size — 5 — the trader never meant. Display keeps using the live value; only
 * the network follows this one.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = React.useState(value);

  React.useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return settled;
}
