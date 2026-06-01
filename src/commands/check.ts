import { detectConflict } from "../conflict.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { formatConflict } from "../render.ts";
import { requireArg } from "../validate.ts";

// Observer-safe. It refreshes the caller's heartbeat *if they already have a live session*
// (agents naturally `check` before editing, so this keeps a working-but-quiet agent live) —
// but it never CREATES a session, so a human or unregistered caller still doesn't appear.
export function run(ctx: Ctx): number {
  const id = ctx.identity;
  if (id) {
    const existing = ctx.store.getSession(id.key);
    if (existing && existing.endedAt === null) ctx.store.touchSession(id.key, ctx.now);
  }

  const target = normalizeTarget(requireArg(ctx.args._[1], "path"), ctx.repo.root, ctx.cwd);
  const conflict = detectConflict({
    store: ctx.store,
    target,
    selfId: ctx.identity?.key ?? null,
    now: ctx.now,
    sessionTtlMs: ctx.config.sessionTtlMs,
    recentMs: ctx.config.recentMs,
  });

  if (conflict.tier === "clear" || conflict.tier === "stale") {
    const note = conflict.tier === "stale" ? " (a stale claim exists; treated as free)" : "";
    ctx.out(`✓ clear: ${target}${note}\n`);
    return 0;
  }
  ctx.out(formatConflict(conflict, ctx.now));
  return 1;
}
