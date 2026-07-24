import type { Ctx } from "../context.ts";
import { requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const worktreeId = ctx.repo.worktreeId;
  const endsSession = Boolean(worktreeId) && ctx.store.getSession(id.key)?.worktreeId === worktreeId;
  ctx.store.transaction(() => {
    ctx.store.addActivity({
      sessionId: id.key,
      ts: ctx.now,
      kind: "done",
      target: null,
      summary: null,
      meta: null,
      worktreeId: ctx.repo.worktreeId,
    });
    ctx.store.releaseAllClaims(id.key, worktreeId ?? null, ctx.now);
    if (endsSession) ctx.store.endSession(id.key, ctx.now);
    pruneAfterWrite(ctx.store, ctx.now);
  });
  ctx.out(`✓ claims released; session ${endsSession ? "ended" : "location is ambiguous, so it remains active"}\n`);
  return 0;
}
