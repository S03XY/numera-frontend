/**
 * How a quote stays current.
 *
 * ## Push or poll — both, and each does the job the other cannot
 *
 * A quote goes stale for two unrelated reasons, and only one of them is something anybody can be
 * notified about:
 *
 *  - **Someone traded.** The book moved, so the curve moved. This is a discrete event, the backend
 *    already knows it the instant it happens, and the market socket already pushes it — see
 *    `useMarketChannel`. Waiting out a timer to discover it is strictly worse on both axes at
 *    once: slower when the market is busy (up to a full interval late) and wasteful when it is
 *    quiet (a read every interval to learn that nothing happened). So a trade invalidates the
 *    quote immediately, and that is where the freshness actually comes from.
 *  - **Time passed.** The spread carries a time term that widens toward close, so the number
 *    drifts with nothing happening at all. Nothing can push that: there is no event, the value is
 *    a continuous function of the clock. Only a timer catches it.
 *
 * A timer is also the only thing that survives a dead socket. A silent websocket and a quiet
 * market look identical from the client, and "identical to quiet" is exactly how a stale quote
 * hides — so the interval is the floor under the push, not a duplicate of it.
 *
 * Hence ten seconds. Fast enough that the visible countdown reads as live and that the time term
 * never drifts far, slow enough to be nearly free: two `eth_call`s against a public RPC, and only
 * while a size is actually in the box and the tab is in the foreground
 * (`refetchIntervalInBackground: false`).
 *
 * ## Why the stale quote was never a money risk
 *
 * Worth stating, because it decides how much this matters. The figure on screen is advisory; the
 * number that goes on chain is the guard. A buy sends the trader's own budget as `maxCost`, so a
 * quote that moved between render and block cannot overspend — it fills for less, or reverts. A
 * sale sends a floor under the proceeds. Refreshing faster buys honesty in the display, not safety.
 */

/** The polling floor for every quote on the ticket. */
export const QUOTE_REFRESH_MS = 10_000;

/**
 * Query-key prefixes the market socket invalidates when the book moves.
 *
 * Listed here rather than inlined at the call site so that adding a third quote query cannot
 * silently miss the push path and quietly fall back to the ten-second timer — which would look
 * like it worked, because it would.
 */
export const QUOTE_QUERY_PREFIXES = [['contract-quote'], ['shares-for-budget']] as const;
