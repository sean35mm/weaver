import { flagBool, flagStr } from "../args.ts";
import type { Ctx } from "../context.ts";
import { targetsOverlap } from "../glob.ts";
import { ago, sessionName } from "../render.ts";
import { normalizeTarget } from "../repo/paths.ts";
import type { ActivityRow } from "../store/store.ts";
import { themeFromCtx } from "../terminal/color.ts";
import { CliError, parseDuration } from "../validate.ts";

interface ActivityFilters {
  kind: string | null;
  path: string | null;
  sinceMs: number | null;
  terms: string[];
}

function matchesActivity(row: ActivityRow, filters: ActivityFilters, now: number): boolean {
  if (filters.kind !== null && row.kind !== filters.kind) return false;
  if (filters.path !== null) {
    if (!row.target || !targetsOverlap(filters.path, row.target)) return false;
  }
  if (filters.sinceMs !== null && now - row.ts > filters.sinceMs) return false;
  if (filters.terms.length) {
    const haystack = `${row.summary ?? ""} ${row.target ?? ""}`.toLowerCase();
    if (!filters.terms.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

export function run(ctx: Ctx): number {
  const kind = flagStr(ctx.args, "kind")?.trim().toLowerCase() || null;
  const pathRaw = flagStr(ctx.args, "path");
  const path = pathRaw ? normalizeTarget(pathRaw, ctx.repo.root, ctx.cwd) : null;
  const sinceRaw = flagStr(ctx.args, "since");
  const sinceMs = sinceRaw ? parseDuration(sinceRaw) : null;
  // A mistyped filter must not silently widen to everything.
  if (sinceRaw && sinceMs === null) throw new CliError("--since expects a duration like 90s, 30m, 2h, or 3d");
  const terms = ctx.args._.slice(1)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const filters: ActivityFilters = { kind, path, sinceMs, terms };
  const filtered = kind !== null || path !== null || sinceMs !== null || terms.length > 0;

  const limit = flagBool(ctx.args, "full") ? 200 : filtered ? 100 : 20;
  // Filters scan everything retained, then cap the display; unfiltered stays cheap.
  const rows = ctx.store
    .listRecentActivity(filtered ? 5000 : limit)
    .filter((row) => matchesActivity(row, filters, ctx.now))
    .slice(0, limit);
  const theme = themeFromCtx(ctx);

  if (flagBool(ctx.args, "json")) {
    ctx.out(
      `${JSON.stringify(
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
      )}\n`,
    );
    return 0;
  }

  if (!rows.length) {
    ctx.out(`${theme.dim(filtered ? "no matching activity" : "no activity yet")}\n`);
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
