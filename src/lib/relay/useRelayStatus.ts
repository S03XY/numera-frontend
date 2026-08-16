'use client';

import { useQuery } from '@tanstack/react-query';
import { endpoints } from '@/lib/api/endpoints';
import type { RelayState } from '@/lib/api/types';

/**
 * Whether a bet can be placed at all right now.
 *
 * Numera pays the network fee on every bet, so the gas relayer is a single point of failure for
 * betting everywhere in the product. When it stops, every ticket fails the same way, and until now
 * the only way a trader found out was by signing a trade, waiting through the shielding animation,
 * and reading an error. This is the same fact, asked before the press.
 *
 * ## Why it fails open
 *
 * A status endpoint is not the relayer. If this query 404s, times out, or the backend is mid
 * deploy, the honest answer is "we do not know", and the cost of the two guesses is wildly
 * asymmetric: guessing unavailable takes betting down across the whole site over a failed GET,
 * while guessing available costs one trade that fails with a message already written for it. So
 * anything other than an explicit `available: false` is treated as available.
 *
 * ## Why the poll is slow
 *
 * The two states it reports change on the order of a day (a spent budget) or a deploy (no relayer
 * configured). A minute is already far finer than the thing being measured, and every open tab
 * pays for it.
 */

const POLL_MS = 60_000;

export interface RelayAvailability extends RelayState {
  /** No answer yet, or the request failed. Reported available; see above. */
  unknown: boolean;
}

const ASSUME_FINE: RelayAvailability = {
  available: true,
  reason: null,
  resolution: true,
  unknown: true,
};

export function useRelayStatus(): RelayAvailability {
  const { data } = useQuery({
    queryKey: ['relay', 'status'],
    queryFn: ({ signal }) => endpoints.relay.status(signal),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    // One retry, not three. A relayer that is down stays down for longer than a retry schedule,
    // and the fallback is already the safe answer.
    retry: 1,
  });

  return data ? { ...data, unknown: false } : ASSUME_FINE;
}
