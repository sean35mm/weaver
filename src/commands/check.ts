import { detectConflict } from "../conflict.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { formatConflict } from "../render.ts";
import { requireArg } from "../validate.ts";

// Observer-safe: resolves identity (if any) only to exclude self; never registers presence.
export function run(ctx: Ctx): number {
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
