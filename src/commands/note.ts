import { flagBool, flagStr, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { targetsOverlap } from "../glob.ts";
import { normalizeTarget } from "../repo/paths.ts";
import type { NoteRow } from "../store/store.ts";
import { CliError, clamp, requireArg, requireIdentity } from "../validate.ts";
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
    const created = ctx.store.addNote({
      sessionId: id.key,
      harness: id.label,
      body,
      path,
      tags,
      pinned,
      createdAt: ctx.now,
      supersedes,
    });
    ctx.store.addActivity({ sessionId: id.key, ts: ctx.now, kind: "note", target: path, summary: body, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
    return created;
  });
  ctx.out(
    `✓ noted #${noteId}${pinned ? " (pinned)" : ""}${supersedes ? ` (supersedes #${supersedes})` : ""}: ${body}\n`,
  );
  return 0;
}

export function runNotes(ctx: Ctx): number {
  const all = flagBool(ctx.args, "all");
  const pathRaw = flagStr(ctx.args, "path");
  const tag = flagStr(ctx.args, "tag")?.trim() || null;
  const path = pathRaw ? normalizeTarget(pathRaw, ctx.repo.root, ctx.cwd) : null;
  const terms = ctx.args._.slice(1)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const filtered = path !== null || tag !== null || terms.length > 0;
  const limit = flagBool(ctx.args, "full") || all || filtered ? 100 : 20;
  // Filters scan everything retained, then cap the display; unfiltered stays cheap.
  const fetch = filtered ? 5000 : limit;
  const notes = (all ? ctx.store.listAllNotes(fetch) : ctx.store.listNotes(fetch))
    .filter((note) => matchesNote(note, { path, tag, terms }))
    .slice(0, limit);

  if (flagBool(ctx.args, "json")) {
    ctx.out(
      `${JSON.stringify(
        notes.map((n) => ({
          id: n.id,
          body: n.body,
          path: n.path,
          tags: n.tags,
          pinned: n.pinned,
          retired: n.retiredAt !== null,
          superseded: n.superseded ?? false,
        })),
      )}\n`,
    );
    return 0;
  }

  if (!notes.length) {
    ctx.out(filtered ? "no matching notes\n" : "no notes yet\n");
    return 0;
  }
  for (const n of notes) {
    const marker = n.retiredAt !== null ? "✗ " : n.pinned ? "📌 " : "• ";
    const history =
      n.retiredAt !== null
        ? `  (retired${n.retireReason ? `: ${n.retireReason}` : ""})`
        : n.superseded
          ? "  (superseded)"
          : "";
    ctx.out(`#${n.id} ${marker}${n.body}${n.path ? `  [${n.path}]` : ""}${history}\n`);
  }
  return 0;
}

function tagTokens(tags: string | null): string[] {
  return (tags ?? "")
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function matchesNote(note: NoteRow, filters: { path: string | null; tag: string | null; terms: string[] }): boolean {
  if (filters.path !== null) {
    if (!note.path && !note.pinned) return false;
    if (note.path && !targetsOverlap(filters.path, note.path)) return false;
  }
  if (filters.tag !== null && !tagTokens(note.tags).includes(filters.tag)) return false;
  if (filters.terms.length) {
    const haystack = `${note.body} ${note.tags ?? ""} ${note.path ?? ""}`.toLowerCase();
    if (!filters.terms.every((term) => haystack.includes(term))) return false;
  }
  return true;
}
