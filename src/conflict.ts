/**
 * Three-tier conflict detection over the store. Never blocks — callers surface the result and
 * let the agent decide. Self is always excluded; stale claims/holders downgrade to `stale`.
 */

import { targetsOverlap } from "./glob.ts";
import { DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "./store/reap.ts";
import type { ActivityRow, ClaimRow, SessionRow, Store } from "./store/store.ts";

export type Tier = "hard" | "soft" | "stale" | "clear";

export interface ConflictHit {
  tier: "hard" | "soft" | "stale";
  session: SessionRow;
  claim?: ClaimRow;
  activity?: ActivityRow;
}

export interface ConflictResult {
  tier: Tier;
  hits: ConflictHit[];
}

export interface DetectOpts {
  store: Store;
  target: string;
  selfId?: string | null;
  now: number;
  sessionTtlMs?: number;
  recentMs?: number;
  activityScan?: number;
}

function dedupeBySession(hits: ConflictHit[]): ConflictHit[] {
  const seen = new Set<string>();
  const out: ConflictHit[] = [];
  for (const h of hits) {
    if (seen.has(h.session.id)) continue;
    seen.add(h.session.id);
    out.push(h);
  }
  return out;
}

export function detectConflict(opts: DetectOpts): ConflictResult {
  const { store, target, now } = opts;
  const selfId = opts.selfId ?? null;
  const ttl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const recentMs = opts.recentMs ?? DEFAULT_RECENT_ACTIVITY_MS;
  const scan = opts.activityScan ?? 200;

  const live = new Map(store.listActiveSessions(now, ttl).map((s) => [s.id, s] as const));

  const hard: ConflictHit[] = [];
  const stale: ConflictHit[] = [];

  for (const claim of store.listOpenClaims()) {
    if (claim.sessionId === selfId) continue;
    if (!targetsOverlap(target, claim.pattern)) continue;
    const holder = live.get(claim.sessionId);
    const expired = now >= claim.expiresAt;
    if (holder && !expired) {
      hard.push({ tier: "hard", session: holder, claim });
    } else {
      const session = holder ?? store.getSession(claim.sessionId);
      if (session) stale.push({ tier: "stale", session, claim });
    }
  }

  const soft: ConflictHit[] = [];
  if (hard.length === 0) {
    const cutoff = now - recentMs;
    for (const act of store.listRecentActivity(scan)) {
      if (act.ts < cutoff) break; // recent-activity is ts-desc
      if (act.sessionId === selfId || !act.target) continue;
      const holder = live.get(act.sessionId);
      if (!holder) continue;
      if (!targetsOverlap(target, act.target)) continue;
      soft.push({ tier: "soft", session: holder, activity: act });
    }
  }

  if (hard.length) return { tier: "hard", hits: dedupeBySession(hard) };
  if (soft.length) return { tier: "soft", hits: dedupeBySession(soft) };
  if (stale.length) return { tier: "stale", hits: dedupeBySession(stale) };
  return { tier: "clear", hits: [] };
}
