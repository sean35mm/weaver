import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { ago } from "../render.ts";

export function run(ctx: Ctx): number {
  const rows = ctx.store.listRecentActivity(flagBool(ctx.args, "full") ? 200 : 20);

  if (flagBool(ctx.args, "json")) {
    ctx.out(
      JSON.stringify(
        rows.map((a) => ({
          kind: a.kind,
          target: a.target,
          summary: a.summary,
          by: ctx.store.getSession(a.sessionId)?.harness ?? null,
          tsMsAgo: ctx.now - a.ts,
        })),
      ) + "\n",
    );
    return 0;
  }

  if (!rows.length) {
    ctx.out("no activity yet\n");
    return 0;
  }
  for (const a of rows) {
    const s = ctx.store.getSession(a.sessionId);
    ctx.out(
      `${ago(ctx.now - a.ts).padStart(7)}  ${(s?.harness ?? "?").padEnd(11)} ${a.kind} ${a.target ?? ""}${a.summary ? ` — ${a.summary}` : ""}\n`,
    );
  }
  return 0;
}
