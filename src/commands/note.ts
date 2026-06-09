import { flagBool, flagStr, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { clamp, CliError, requireArg, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function runNote(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const body = clamp(requireArg(rest(ctx.args, 1), "note"));
  const pathRaw = flagStr(ctx.args, "path");
  const path = pathRaw ? normalizeTarget(pathRaw, ctx.repo.root, ctx.cwd) : null;
  const tags = flagStr(ctx.args, "tag") ?? null;

  // `--update <id>` supersedes an existing note: the old note disappears from listings and
  // this one replaces it. A wrong id is a hard error — silently superseding nothing would lie.
  const updateRaw = flagStr(ctx.args, "update");
  let supersedes: number | null = null;
  let superseded = null;
  if (updateRaw !== undefined) {
    const n = Number(updateRaw);
    if (!Number.isInteger(n) || n <= 0) throw new CliError("--update expects a note id (see `weaver notes`)");
    superseded = ctx.store.getNote(n) ?? null;
    if (!superseded) throw new CliError(`note #${n} not found`);
    supersedes = n;
  }

  // Pinned learnings stay pinned across updates unless re-pinning is explicit.
  const pinned = flagBool(ctx.args, "pin") || (superseded?.pinned ?? false);

  const noteId = ctx.store.transaction(() => {
    const created = ctx.store.addNote({ sessionId: id.key, harness: id.label, body, path, tags, pinned, createdAt: ctx.now, supersedes });
    ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "note", target: path, summary: body, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
    return created;
  });
  ctx.out(`✓ noted #${noteId}${pinned ? " (pinned)" : ""}${supersedes ? ` (supersedes #${supersedes})` : ""}: ${body}\n`);
  return 0;
}

export function runNotes(ctx: Ctx): number {
  const notes = ctx.store.listNotes(flagBool(ctx.args, "full") ? 100 : 20);
  if (!notes.length) {
    ctx.out("no notes yet\n");
    return 0;
  }
  for (const n of notes) ctx.out(`#${n.id} ${n.pinned ? "📌 " : "• "}${n.body}${n.path ? `  [${n.path}]` : ""}\n`);
  return 0;
}
