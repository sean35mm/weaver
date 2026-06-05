import { detectConflict, type ConflictHit, type Tier } from "./conflict.ts";
import { targetsOverlap } from "./glob.ts";
import { DEFAULT_ACTIVITY_MAX_EVENTS } from "./store/reap.ts";
import { isBroadGlob } from "./validate.ts";
import type { SessionRow, Store } from "./store/store.ts";

export type PreflightSeverity = "clear" | "info" | "soft" | "hard";
export type PreflightRecommendation = "continue" | "ask-user";

export interface PreflightPathConflict {
  path: string;
  tier: Exclude<Tier, "clear">;
  hits: ConflictHit[];
}

export interface PreflightResult {
  paths: string[];
  severity: PreflightSeverity;
  recommendation: PreflightRecommendation;
  conflicts: PreflightPathConflict[];
  stale: PreflightPathConflict[];
  unrelatedSessions: SessionRow[];
  warnings: string[];
}

export interface PreflightOpts {
  store: Store;
  paths: string[];
  selfId?: string | null;
  now: number;
  sessionTtlMs: number;
  recentMs: number;
}

function severityForTier(tier: Tier): PreflightSeverity {
  if (tier === "hard") return "hard";
  if (tier === "soft") return "soft";
  if (tier === "stale") return "info";
  return "clear";
}

function maxSeverity(a: PreflightSeverity, b: PreflightSeverity): PreflightSeverity {
  const rank: Record<PreflightSeverity, number> = { clear: 0, info: 1, soft: 2, hard: 3 };
  return rank[b] > rank[a] ? b : a;
}

export function hasBroadClaim(hit: ConflictHit): boolean {
  return hit.claim ? isBroadGlob(hit.claim.pattern) : false;
}

export function runPreflight(opts: PreflightOpts): PreflightResult {
  const selfId = opts.selfId ?? null;
  const conflicts: PreflightPathConflict[] = [];
  const stale: PreflightPathConflict[] = [];
  let severity: PreflightSeverity = "clear";
  const relevantLiveSessionIds = new Set<string>();
  const live = opts.store.listActiveSessions(opts.now, opts.sessionTtlMs).filter((s) => s.id !== selfId);
  const liveById = new Map(live.map((s) => [s.id, s] as const));
  const cutoff = opts.now - opts.recentMs;
  const recentActivity = opts.store
    .listRecentActivity(DEFAULT_ACTIVITY_MAX_EVENTS)
    .filter((act) => act.ts >= cutoff && act.sessionId !== selfId && act.target && liveById.has(act.sessionId));

  const softHitsForPath = (path: string, excluded: Set<string>): ConflictHit[] => {
    const seen = new Set<string>();
    const hits: ConflictHit[] = [];
    for (const act of recentActivity) {
      if (!act.target || excluded.has(act.sessionId) || seen.has(act.sessionId)) continue;
      if (!targetsOverlap(path, act.target)) continue;
      const session = liveById.get(act.sessionId);
      if (!session) continue;
      seen.add(act.sessionId);
      hits.push({ tier: "soft", session, activity: act });
    }
    return hits;
  };

  for (const path of opts.paths) {
    const conflict = detectConflict({
      store: opts.store,
      target: path,
      selfId,
      now: opts.now,
      sessionTtlMs: opts.sessionTtlMs,
      recentMs: opts.recentMs,
      activityScan: DEFAULT_ACTIVITY_MAX_EVENTS,
    });

    const pathSeverity = severityForTier(conflict.tier);
    severity = maxSeverity(severity, pathSeverity);

    if (conflict.tier === "hard" || conflict.tier === "soft") {
      conflicts.push({ path, tier: conflict.tier, hits: conflict.hits });
      for (const hit of conflict.hits) relevantLiveSessionIds.add(hit.session.id);
      if (conflict.tier === "hard") {
        const hardSessionIds = new Set(conflict.hits.map((hit) => hit.session.id));
        const softHits = softHitsForPath(path, hardSessionIds);
        if (softHits.length) {
          conflicts.push({ path, tier: "soft", hits: softHits });
          for (const hit of softHits) relevantLiveSessionIds.add(hit.session.id);
        }
      }
    } else if (conflict.tier === "stale") {
      stale.push({ path, tier: "stale", hits: conflict.hits });
      for (const hit of conflict.hits) relevantLiveSessionIds.add(hit.session.id);
    }
  }

  if (stale.length && severity === "clear") severity = "info";

  const unrelatedSessions = live.filter((s) => !relevantLiveSessionIds.has(s.id));
  const warnings: string[] = [];
  if (!selfId && live.length) {
    warnings.push("session identity is unresolved; Weaver cannot exclude this caller from other active sessions");
  }

  return {
    paths: opts.paths,
    severity,
    recommendation: severity === "hard" || severity === "soft" ? "ask-user" : "continue",
    conflicts,
    stale,
    unrelatedSessions,
    warnings,
  };
}
