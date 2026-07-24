/**
 * Three-tier conflict detection over the store. Never blocks — callers surface the result and
 * let the agent decide. Known same-worktree self records are excluded; stale claims/holders
 * downgrade to `stale`.
 */

import { targetsOverlap } from "./glob.ts";
import { DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "./store/reap.ts";
import type { ActivityRow, ClaimRow, SessionRow, Store } from "./store/store.ts";

export type Tier = "hard" | "soft" | "stale" | "clear";
export type WorktreeRelation = "same-worktree" | "different-worktree" | "unknown-worktree";

export interface ConflictHit {
  tier: "hard" | "soft" | "stale";
  session: SessionRow;
  claim?: ClaimRow;
  activity?: ActivityRow;
  relation: WorktreeRelation;
}

export interface ConflictResult {
  tier: Tier;
  hits: ConflictHit[];
  /** Known-different checkouts are visible, but their files cannot collide. */
  informationalHits: ConflictHit[];
  hardHits: ConflictHit[];
  softHits: ConflictHit[];
  staleHits: ConflictHit[];
}

export interface DetectOpts {
  store: Store;
  target: string;
  selfId?: string | null;
  now: number;
  sessionTtlMs?: number;
  recentMs?: number;
  activityScan?: number;
  worktreeId?: string | null;
}

function relationFor(caller: string | null | undefined, source: string | null | undefined): WorktreeRelation {
  if (!caller || !source) return "unknown-worktree";
  return caller === source ? "same-worktree" : "different-worktree";
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
  const worktreeId = opts.worktreeId ?? null;

  const live = new Map(store.listActiveSessions(now, ttl).map((s) => [s.id, s] as const));

  const hard: ConflictHit[] = [];
  const informational: ConflictHit[] = [];
  const stale: ConflictHit[] = [];

  for (const claim of store.listOpenClaims()) {
    const relation = relationFor(worktreeId, claim.worktreeId);
    if (claim.sessionId === selfId && relation === "same-worktree") continue;
    if (!targetsOverlap(target, claim.pattern)) continue;
    const holder = live.get(claim.sessionId);
    const expired = now >= claim.expiresAt;
    if (holder && !expired) {
      const hit = {
        tier: "hard" as const,
        session: holder,
        claim,
        relation,
      };
      if (hit.relation === "different-worktree") informational.push(hit);
      else hard.push(hit);
    } else {
      const session = holder ?? store.getSession(claim.sessionId);
      if (session) stale.push({ tier: "stale", session, claim, relation });
    }
  }

  const soft: ConflictHit[] = [];
  const cutoff = now - recentMs;
  for (const act of store.listRecentActivity(scan)) {
    if (act.ts < cutoff) break; // recent-activity is ts-desc
    const relation = relationFor(worktreeId, act.worktreeId);
    if ((act.sessionId === selfId && relation === "same-worktree") || !act.target) continue;
    const holder = live.get(act.sessionId);
    if (!holder) continue;
    if (!targetsOverlap(target, act.target)) continue;
    const hit = {
      tier: "soft" as const,
      session: holder,
      activity: act,
      relation,
    };
    if (hit.relation === "different-worktree") informational.push(hit);
    else soft.push(hit);
  }

  const hardHits = dedupeBySession(hard);
  const softHits = dedupeBySession(soft);
  const staleHits = dedupeBySession(stale);
  const informationalHits = dedupeBySession(informational);
  if (hardHits.length) return { tier: "hard", hits: hardHits, informationalHits, hardHits, softHits, staleHits };
  if (softHits.length) return { tier: "soft", hits: softHits, informationalHits, hardHits, softHits, staleHits };
  if (staleHits.length) return { tier: "stale", hits: staleHits, informationalHits, hardHits, softHits, staleHits };
  return { tier: "clear", hits: [], informationalHits, hardHits, softHits, staleHits };
}
