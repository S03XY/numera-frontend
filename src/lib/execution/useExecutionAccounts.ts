'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePool } from '@/lib/pool/PoolProvider';
import { endpoints } from '@/lib/api/endpoints';
import { marketAccountAddress } from './keys';

/**
 * Every address this user trades through, derived rather than remembered.
 *
 * ## Why there is no longer a stored list
 *
 * The portfolio used to read a localStorage registry that the execution layer appended to whenever
 * it allocated an account. That made the list a *cache of something unrecoverable*: clearing the
 * browser lost the ability to find your own positions, which is why there was a "restore positions"
 * button at all.
 *
 * Accounts are derived now — a pure function of the root secret and the market id — so the list can
 * simply be computed. Nothing to store, nothing to lose, nothing to restore. A new device with the
 * same passkey reproduces every address.
 *
 * ## It is also more private than the registry was
 *
 * `POST /positions/query` takes the address list. A list containing only the markets the user has
 * touched tells our backend exactly which markets they are in — the shape of their book, if not
 * their name. Deriving across the whole catalogue sends the same list for everyone, so it says
 * nothing at all. The extra addresses cost one query and return nothing.
 *
 * The server still cannot link any of it to a login; that link does not exist. This just removes a
 * second-order leak that the registry made easy to miss.
 */

/**
 * The server's own maximum page size — see `PaginationDto` in the backend.
 *
 * Not a preference. `limit` above this is a **400**, not a clamp, and this hook once asked for 200:
 * the list request failed on every render, the derived address list came back empty, the positions
 * query never ran, and every screen in the app reported that the user held nothing. A balance read
 * straight from the chain still showed money, which made it look like an indexer problem rather
 * than a request that was rejected before it was ever answered.
 */
const PAGE_SIZE = 100;

/**
 * How far to page before giving up.
 *
 * Derivation is a HKDF and a secp256k1 multiplication per market — tens of microseconds — so the
 * cost here is the requests, not the maths. Five pages is five hundred markets, and a catalogue
 * past that gets a console error rather than a silently short list, because a truncated list does
 * not look broken: it looks like a user with no positions.
 */
const MAX_PAGES = 5;

interface Catalogue {
  ids: string[];
  /** False when the catalogue outgrew {@link MAX_PAGES} and the list is short. */
  complete: boolean;
}

/**
 * Every market id, paged.
 *
 * Deliberately its own query rather than a call into `useMarkets`, for two reasons: that hook polls
 * on a four-second tick to keep prices live, and this list does not need it — market ids change
 * when a market is created — and it fetches one page, which is the bug above.
 */
function useMarketIds(enabled: boolean): Catalogue {
  const { data } = useQuery({
    queryKey: ['execution', 'market-catalogue'],
    queryFn: async ({ signal }): Promise<Catalogue> => {
      const ids: string[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await endpoints.markets.list(
          { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
          signal,
        );
        ids.push(...res.items.map((m) => m.id));
        if (ids.length >= res.total || res.items.length < PAGE_SIZE) {
          return { ids, complete: true };
        }
      }
      // Loud, because the symptom is indistinguishable from having no positions.
      console.error(
        `[numera] market catalogue exceeds ${MAX_PAGES * PAGE_SIZE}; positions in markets past ` +
          'that point will not be found. Derive per visited market instead of raising this.',
      );
      return { ids, complete: false };
    },
    enabled,
    // Ids change when a market is created, which is not something to poll for on a trading screen.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });

  return data ?? { ids: [], complete: false };
}

export function useExecutionAccounts(): string[] {
  const { executionRoot } = usePool();
  const { ids } = useMarketIds(Boolean(executionRoot));

  const marketIds = React.useMemo(() => [...ids].sort(), [ids]);

  return React.useMemo(() => {
    if (!executionRoot || marketIds.length === 0) return [];
    return marketIds.map((id) => marketAccountAddress(executionRoot, id));
  }, [executionRoot, marketIds]);
}
