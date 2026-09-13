/**
 * Waiting for the data API to catch up with a mined transaction.
 *
 * `api.vfat.io` indexes a few seconds behind the chain, so the first read
 * after a confirmed write legitimately returns the pre-write state. A single
 * refetch on confirmation therefore *caches* the stale answer and nothing ever
 * corrects it — the panel keeps showing an undeployed Sickle or an unconsented
 * mask until the user reloads.
 *
 * A single fixed sleep is not the fix either: it is a guess that is too long
 * when the indexer is quick and too short when it is behind, and it still
 * reads exactly once at the end of it. Poll across a window instead, so the
 * panel converges whenever the write lands, and bound the window so a write
 * that never lands does not poll forever.
 */

/** How long to keep looking for a write to show up. */
export const INDEX_WINDOW_MS = 30_000;

/** Gap between attempts while waiting. */
export const INDEX_POLL_MS = 3_000;

/** A deadline `INDEX_WINDOW_MS` from now. */
export function indexDeadline(): number {
  return Date.now() + INDEX_WINDOW_MS;
}

/**
 * The `refetchInterval` for a query that is waiting for a write to appear.
 *
 * Polls until the deadline. `settled` is an optional early exit and defaults
 * to off, because getting it wrong is worse than polling a few extra times:
 * a condition that reads "changed" for the wrong reason stops the poll dead
 * and leaves the stale answer cached, which is the very bug this exists to
 * prevent. An earlier version compared a fingerprint of the list captured in
 * another component, and a rebalance's new NFT id never reached the page.
 *
 * Pass `settled` only where the condition is unambiguous — a Sickle address
 * existing, a consent bit being set — never where it is a guess about whether
 * data "looks different".
 */
export function pollWhileIndexing(
  deadline: number,
  settled = false
): number | false {
  if (settled) return false;
  if (Date.now() > deadline) return false;
  return INDEX_POLL_MS;
}
