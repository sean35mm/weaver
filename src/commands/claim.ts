import { flagStr } from "../args.ts";
import { detectConflict } from "../conflict.ts";
import type { Ctx } from "../context.ts";
import { formatConflict, formatInformationalConflict } from "../render.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { themeFromCtx } from "../terminal/color.ts";
import { clamp, isBroadGlob, parseTtl, requireArg, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function runClaim(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const theme = themeFromCtx(ctx);
  const pattern = normalizeTarget(requireArg(ctx.args._[1], "glob"), ctx.repo.root, ctx.cwd);
  const reasonRaw = flagStr(ctx.args, "reason");
  const reason = reasonRaw ? clamp(reasonRaw) : null;
  const ttlMs = parseTtl(flagStr(ctx.args, "ttl"), ctx.config.claimTtlMs);

  // Surface overlaps with other live sessions before recording (advisory, never blocks).
  const conflict = detectConflict({
    store: ctx.store,
    target: pattern,
    selfId: id.key,
    now: ctx.now,
    sessionTtlMs: ctx.config.sessionTtlMs,
    recentMs: ctx.config.recentMs,
    worktreeId: ctx.repo.worktreeId,
  });

  ctx.store.transaction(() => {
    const scratchpadId = ctx.repo.worktreeId
      ? (ctx.store.getScratchpadAttachment(id.key, ctx.repo.worktreeId)?.scratchpadId ?? null)
      : null;
    // Refresh: supersede our own prior claim on the same pattern, then (re)record.
    ctx.store.releaseClaim(id.key, pattern, ctx.repo.worktreeId, ctx.now);
    ctx.store.addClaim({
      sessionId: id.key,
      pattern,
      reason,
      createdAt: ctx.now,
      expiresAt: ctx.now + ttlMs,
      worktreeId: ctx.repo.worktreeId,
      scratchpadId,
    });
    ctx.store.addActivity({
      sessionId: id.key,
      ts: ctx.now,
      kind: "claim",
      target: pattern,
      summary: reason,
      meta: null,
      worktreeId: ctx.repo.worktreeId,
      scratchpadId,
    });
    pruneAfterWrite(ctx.store, ctx.now);
  });

  if (isBroadGlob(pattern))
    ctx.err(`⚠ ${theme.warn(`'${pattern}' is very broad`)} — you're claiming most/all of the repo.\n`);
  ctx.out(`${theme.success("✓ claimed")} ${theme.path(pattern)}${reason ? ` ${theme.dim("—")} ${reason}` : ""}\n`);

  if (conflict.tier === "hard" || conflict.tier === "soft") {
    ctx.out("\n" + formatConflict(conflict, ctx.now, theme));
    if (conflict.informationalHits.length)
      ctx.out("\n" + formatInformationalConflict(conflict.informationalHits, ctx.now, theme));
    return 1; // non-zero so the agent stops and coordinates instead of silently proceeding
  }
  if (conflict.informationalHits.length)
    ctx.out("\n" + formatInformationalConflict(conflict.informationalHits, ctx.now, theme));
  return 0;
}

export function runRelease(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const theme = themeFromCtx(ctx);
  const pattern = normalizeTarget(requireArg(ctx.args._[1], "glob"), ctx.repo.root, ctx.cwd);
  ctx.store.transaction(() => {
    const scratchpadId = ctx.repo.worktreeId
      ? (ctx.store.getScratchpadAttachment(id.key, ctx.repo.worktreeId)?.scratchpadId ?? null)
      : null;
    ctx.store.releaseClaim(id.key, pattern, ctx.repo.worktreeId, ctx.now);
    ctx.store.addActivity({
      sessionId: id.key,
      ts: ctx.now,
      kind: "release",
      target: pattern,
      summary: null,
      meta: null,
      worktreeId: ctx.repo.worktreeId,
      scratchpadId,
    });
    pruneAfterWrite(ctx.store, ctx.now);
  });
  ctx.out(`${theme.success("✓ released")} ${theme.path(pattern)}\n`);
  return 0;
}
