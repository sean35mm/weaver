import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { claimsByLiveHolders, formatStatus, type StatusData, selectStatusScratchpads, statusJson } from "../render.ts";
import { DEFAULT_COMPLETED_SESSION_RECENT_MS } from "../store/reap.ts";
import { themeFromCtx } from "../terminal/color.ts";

function isKnownSelf(
  selfId: string | null,
  callerWorktreeId: string | null | undefined,
  recordId: string,
  recordWorktreeId: string | null | undefined,
): boolean {
  return !!selfId && selfId === recordId && !!callerWorktreeId && callerWorktreeId === recordWorktreeId;
}

function hydrateRelevantScratchpads(ctx: Ctx, data: StatusData, liveSessionIds: ReadonlySet<string>): StatusData {
  const scratchpads = [...(data.scratchpads ?? [])];
  const present = new Set(scratchpads.map((pad) => pad.id));
  const relevant = new Set<number>();
  for (const attachment of data.scratchpadAttachments ?? []) {
    if (liveSessionIds.has(attachment.sessionId)) relevant.add(attachment.scratchpadId);
  }
  for (const claim of data.claims) {
    if (claim.scratchpadId != null) relevant.add(claim.scratchpadId);
  }
  for (const activity of data.activity) {
    if (activity.scratchpadId != null) relevant.add(activity.scratchpadId);
  }
  for (const id of relevant) {
    if (present.has(id)) continue;
    const pad = ctx.store.getScratchpad(id);
    if (pad?.state === "active") scratchpads.push(pad);
  }
  return { ...data, scratchpads };
}

// Observer: shows the picture of OTHER sessions; never registers presence.
export function run(ctx: Ctx): number {
  const self = ctx.identity?.key ?? null;
  const worktreeId = ctx.repo.worktreeId;
  const full = flagBool(ctx.args, "full");
  const theme = themeFromCtx(ctx);

  const live = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs);
  const recentCutoff = ctx.now - ctx.config.recentMs;
  const completedCutoff = ctx.now - DEFAULT_COMPLETED_SESSION_RECENT_MS;
  const data: StatusData = {
    sessions: live.filter((s) => !isKnownSelf(self, worktreeId, s.id, s.worktreeId)),
    completed: ctx.store
      .listRecentEndedSessions(full ? 20 : 3, completedCutoff)
      .filter((s) => !isKnownSelf(self, worktreeId, s.id, s.worktreeId)),
    // only claims held by a live session, excluding known same-worktree records
    claims: claimsByLiveHolders(ctx.store.listActiveClaims(ctx.now), live).filter(
      (c) => !isKnownSelf(self, worktreeId, c.sessionId, c.worktreeId),
    ),
    // only genuinely recent activity, excluding known same-worktree records
    activity: ctx.store
      .listRecentActivity(full ? 100 : 8)
      .filter((a) => !isKnownSelf(self, worktreeId, a.sessionId, a.worktreeId) && (full || a.ts >= recentCutoff)),
    notes: ctx.store.listNotes(full ? 100 : 5),
    scratchpads: ctx.store.listScratchpads(["active"], full ? 100 : 10),
    scratchpadAttachments: ctx.store.listScratchpadAttachments(),
  };
  const visibleSessionIds = new Set(data.sessions.map((session) => session.id));

  if (flagBool(ctx.args, "json")) {
    ctx.out(JSON.stringify(statusJson(ctx.repo.repoId, data, ctx.now, ctx.store)) + "\n");
    return 0;
  }

  const renderData = full ? data : hydrateRelevantScratchpads(ctx, data, visibleSessionIds);

  // Silent when there's nothing worth an agent's tokens. Notes count even unpinned:
  // durable learnings must surface in a quiet repo, not just while activity is fresh.
  if (
    !data.sessions.length &&
    !data.claims.length &&
    !data.notes.length &&
    !data.activity.length &&
    !data.completed.length &&
    !selectStatusScratchpads(renderData, full ? "all" : "relevant", visibleSessionIds).length
  ) {
    ctx.out(`${theme.success("weaver:")} no other active agents\n`);
    return 0;
  }

  ctx.out(
    formatStatus(renderData, ctx.now, ctx.store, theme, {
      scratchpads: full ? "all" : "relevant",
      liveAttachmentSessions: visibleSessionIds,
    }),
  );
  return 0;
}
