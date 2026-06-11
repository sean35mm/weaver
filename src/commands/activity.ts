import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { ago, sessionName } from "../render.ts";
import { themeFromCtx } from "../terminal/color.ts";

export function run(ctx: Ctx): number {
  const rows = ctx.store.listRecentActivity(flagBool(ctx.args, "full") ? 200 : 20);
  const theme = themeFromCtx(ctx);

  if (flagBool(ctx.args, "json")) {
    ctx.out(
      JSON.stringify(
        rows.map((a) => {
          const s = ctx.store.getSession(a.sessionId);
          return {
            kind: a.kind,
            target: a.target,
            summary: a.summary,
            by: s ? sessionName(s) : null,
            tsMsAgo: ctx.now - a.ts,
          };
        }),
      ) + "\n",
    );
    return 0;
  }

  if (!rows.length) {
    ctx.out(`${theme.dim("no activity yet")}\n`);
    return 0;
  }
  for (const a of rows) {
    const s = ctx.store.getSession(a.sessionId);
    ctx.out(
      `${theme.dim(ago(ctx.now - a.ts).padStart(7))}  ${theme.accent((s ? sessionName(s) : "?").padEnd(11))} ${theme.kind(a.kind)} ${a.target ? theme.path(a.target) : ""}${a.summary ? ` ${theme.dim("—")} ${a.summary}` : ""}\n`,
    );
  }
  return 0;
}
