import { rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { clamp, requireArg, requireIdentity } from "../validate.ts";

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const intent = clamp(requireArg(rest(ctx.args, 1), "intent"));
  ctx.store.setIntent(id.key, intent, ctx.now);
  ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "task", target: null, summary: intent, meta: null });
  ctx.out(`✓ task: ${intent}\n`);
  return 0;
}
