import { type ConflictHit, detectConflict, type Tier } from "./conflict.ts";
import { DEFAULT_ACTIVITY_MAX_EVENTS } from "./store/reap.ts";
import type { SessionRow, Store } from "./store/store.ts";
import { isBroadGlob } from "./validate.ts";

export type PreflightSeverity = "clear" | "info" | "soft" | "hard";
export type PreflightRecommendation = "continue" | "ask-user";

export interface PreflightPathConflict {
  path: string;
  tier: Exclude<Tier, "clear"> | "info";
  hits: ConflictHit[];
}

export interface PreflightResult {
  paths: string[];
  severity: PreflightSeverity;
  recommendation: PreflightRecommendation;
  conflicts: PreflightPathConflict[];
  stale: PreflightPathConflict[];
  informational: PreflightPathConflict[];
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
  worktreeId?: string | null;
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
  const informational: PreflightPathConflict[] = [];
  let severity: PreflightSeverity = "clear";
  const relevantLiveSessionIds = new Set<string>();
  const live = opts.store.listActiveSessions(opts.now, opts.sessionTtlMs).filter((s) => s.id !== selfId);
  for (const path of opts.paths) {
    const conflict = detectConflict({
      store: opts.store,
      target: path,
      selfId,
      now: opts.now,
      sessionTtlMs: opts.sessionTtlMs,
      recentMs: opts.recentMs,
      activityScan: DEFAULT_ACTIVITY_MAX_EVENTS,
      worktreeId: opts.worktreeId,
    });

    const pathSeverity = severityForTier(conflict.tier);
    severity = maxSeverity(severity, pathSeverity);

    if (conflict.hardHits.length) conflicts.push({ path, tier: "hard", hits: conflict.hardHits });
    if (conflict.softHits.length) conflicts.push({ path, tier: "soft", hits: conflict.softHits });
    if (conflict.staleHits.length) stale.push({ path, tier: "stale", hits: conflict.staleHits });
    if (conflict.informationalHits.length) informational.push({ path, tier: "info", hits: conflict.informationalHits });
    for (const hit of [
      ...conflict.hardHits,
      ...conflict.softHits,
      ...conflict.staleHits,
      ...conflict.informationalHits,
    ])
      relevantLiveSessionIds.add(hit.session.id);
  }

  if ((stale.length || informational.length) && severity === "clear") severity = "info";

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
    informational,
    unrelatedSessions,
    warnings,
  };
}
