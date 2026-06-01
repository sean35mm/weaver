import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { claimsByLiveHolders, formatStatus, statusJson, type StatusData } from "../render.ts";

// Observer: shows the picture of OTHER sessions; never registers presence.
export function run(ctx: Ctx): number {
  const self = ctx.identity?.key ?? null;
  const full = flagBool(ctx.args, "full");

  const live = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs);
  const recentCutoff = ctx.now - ctx.config.recentMs;
  const data: StatusData = {
    sessions: live.filter((s) => s.id !== self),
    // only claims held by a live session, excluding our own
    claims: claimsByLiveHolders(ctx.store.listActiveClaims(ctx.now), live).filter((c) => c.sessionId !== self),
    // only genuinely recent activity, excluding our own
    activity: ctx.store
      .listRecentActivity(full ? 100 : 8)
      .filter((a) => a.sessionId !== self && (full || a.ts >= recentCutoff)),
    notes: ctx.store.listNotes(full ? 100 : 5),
  };

  if (flagBool(ctx.args, "json")) {
    ctx.out(JSON.stringify(statusJson(ctx.repo.repoId, data, ctx.now, ctx.store)) + "\n");
    return 0;
  }

  // Silent when there's nothing worth an agent's tokens.
  const pinned = data.notes.filter((n) => n.pinned);
  if (!data.sessions.length && !data.claims.length && !pinned.length && !data.activity.length) {
    ctx.out("weaver: no other active agents\n");
    return 0;
  }

  ctx.out(formatStatus(data, ctx.now, ctx.store));
  return 0;
}
