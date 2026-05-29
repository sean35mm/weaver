import type { Ctx } from "../context.ts";
import { requireIdentity } from "../validate.ts";

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "done", target: null, summary: null, meta: null });
  ctx.store.releaseAllClaims(id.key, ctx.now);
  ctx.store.endSession(id.key, ctx.now);
  ctx.out("✓ session ended; claims released\n");
  return 0;
}
