import { flagStr, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { clamp, normalizeKind, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const { kind, warning } = normalizeKind(ctx.args._[1]);
  if (warning) ctx.err(`⚠ ${warning}\n`);

  const targetRaw = ctx.args._[2];
  const target = targetRaw ? normalizeTarget(targetRaw, ctx.repo.root, ctx.cwd) : null;

  const summaryRaw = rest(ctx.args, 3) || flagStr(ctx.args, "summary") || "";
  const summary = summaryRaw ? clamp(summaryRaw) : null;
  ctx.store.transaction(() => {
    const scratchpadId = ctx.repo.worktreeId
      ? (ctx.store.getScratchpadAttachment(id.key, ctx.repo.worktreeId)?.scratchpadId ?? null)
      : null;
    ctx.store.addActivity({
      sessionId: id.key,
      ts: ctx.now,
      kind,
      target,
      summary,
      meta: null,
      worktreeId: ctx.repo.worktreeId,
      scratchpadId,
    });
    pruneAfterWrite(ctx.store, ctx.now);
  });

  ctx.out(`✓ logged ${kind}${target ? ` ${target}` : ""}\n`);
  return 0;
}
