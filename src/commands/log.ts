import { flagStr, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { DEFAULT_ACTIVITY_MAX_AGE_DAYS, DEFAULT_ACTIVITY_MAX_EVENTS } from "../store/reap.ts";
import { clamp, normalizeKind, requireIdentity } from "../validate.ts";

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const { kind, warning } = normalizeKind(ctx.args._[1]);
  if (warning) ctx.err(`⚠ ${warning}\n`);

  const targetRaw = ctx.args._[2];
  const target = targetRaw ? normalizeTarget(targetRaw, ctx.repo.root, ctx.cwd) : null;

  const summaryRaw = rest(ctx.args, 3) || flagStr(ctx.args, "summary") || "";
  const summary = summaryRaw ? clamp(summaryRaw) : null;

  ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind, target, summary, meta: null });
  ctx.store.pruneActivity({ maxEvents: DEFAULT_ACTIVITY_MAX_EVENTS, maxAgeDays: DEFAULT_ACTIVITY_MAX_AGE_DAYS, now: ctx.now });

  ctx.out(`✓ logged ${kind}${target ? ` ${target}` : ""}\n`);
  return 0;
}
