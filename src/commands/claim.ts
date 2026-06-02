import { flagStr } from "../args.ts";
import { detectConflict } from "../conflict.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { formatConflict } from "../render.ts";
import { clamp, isBroadGlob, parseTtl, requireArg, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function runClaim(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
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
  });

  ctx.store.transaction(() => {
    // Refresh: supersede our own prior claim on the same pattern, then (re)record.
    ctx.store.releaseClaim(id.key, pattern, ctx.now);
    ctx.store.addClaim({ sessionId: id.key, pattern, reason, createdAt: ctx.now, expiresAt: ctx.now + ttlMs });
    ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "claim", target: pattern, summary: reason, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
  });

  if (isBroadGlob(pattern)) ctx.err(`⚠ '${pattern}' is very broad — you're claiming most/all of the repo.\n`);
  ctx.out(`✓ claimed ${pattern}${reason ? ` — ${reason}` : ""}\n`);

  if (conflict.tier === "hard" || conflict.tier === "soft") {
    ctx.out("\n" + formatConflict(conflict, ctx.now));
    return 1; // non-zero so the agent stops and coordinates instead of silently proceeding
  }
  return 0;
}

export function runRelease(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const pattern = normalizeTarget(requireArg(ctx.args._[1], "glob"), ctx.repo.root, ctx.cwd);
  ctx.store.transaction(() => {
    ctx.store.releaseClaim(id.key, pattern, ctx.now);
    ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "release", target: pattern, summary: null, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
  });
  ctx.out(`✓ released ${pattern}\n`);
  return 0;
}
