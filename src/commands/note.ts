import { flagBool, flagStr, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { clamp, requireArg, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

export function runNote(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const body = clamp(requireArg(rest(ctx.args, 1), "note"));
  const pathRaw = flagStr(ctx.args, "path");
  const path = pathRaw ? normalizeTarget(pathRaw, ctx.repo.root, ctx.cwd) : null;
  const tags = flagStr(ctx.args, "tag") ?? null;
  const pinned = flagBool(ctx.args, "pin");
  const updateRaw = flagStr(ctx.args, "update");
  const supersedes = updateRaw && Number.isFinite(Number(updateRaw)) ? Number(updateRaw) : null;

  ctx.store.transaction(() => {
    ctx.store.addNote({ sessionId: id.key, harness: id.label, body, path, tags, pinned, createdAt: ctx.now, supersedes });
    ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "note", target: path, summary: body, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
  });
  ctx.out(`✓ noted${pinned ? " (pinned)" : ""}: ${body}\n`);
  return 0;
}

export function runNotes(ctx: Ctx): number {
  const notes = ctx.store.listNotes(flagBool(ctx.args, "full") ? 100 : 20);
  if (!notes.length) {
    ctx.out("no notes yet\n");
    return 0;
  }
  for (const n of notes) ctx.out(`${n.pinned ? "📌 " : "• "}${n.body}${n.path ? `  [${n.path}]` : ""}\n`);
  return 0;
}
