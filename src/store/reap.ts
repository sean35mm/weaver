/**
 * Lazy staleness + retention helpers. There is no daemon: liveness and pruning are computed
 * at read/write time. Pure functions here are unit-tested; the SQL that applies them lives in
 * the SQLite store.
 */

export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 min — presence staleness
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000; // 30 min — claim expiry
export const DEFAULT_RECENT_ACTIVITY_MS = 20 * 60 * 1000; // soft-conflict window

export const DEFAULT_ACTIVITY_MAX_EVENTS = 5000;
export const DEFAULT_ACTIVITY_MAX_AGE_DAYS = 14;

/** A session is stale when its last heartbeat is older than the TTL. */
export function isStale(lastSeen: number, now: number, ttlMs: number): boolean {
  return now - lastSeen > ttlMs;
}

/** A claim is expired when `now` is at or past its expiry. */
export function isExpiredClaim(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

/** Activity older than this cutoff is eligible for pruning. */
export function ageCutoff(now: number, maxAgeDays: number): number {
  return now - maxAgeDays * 24 * 60 * 60 * 1000;
}
