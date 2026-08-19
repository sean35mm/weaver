/**
 * Retire a note from the commons — soft, audited, reversible. Agents use this when they
 * discover a recorded learning is wrong or has become noise; the row is never deleted, it
 * just leaves the current picture (`notes --all` still shows it; `--undo` brings it back).
 */

import { flagBool, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import { themeFromCtx } from "../terminal/color.ts";
import { CliError, clamp, requireArg, requireIdentity } from "../validate.ts";
import { pruneAfterWrite } from "./prune.ts";

function noteId(ctx: Ctx): number {
  const raw = requireArg(ctx.args._[1], "note id");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError("forget expects a note id (see `weaver notes`)");
  return n;
}

export function run(ctx: Ctx): number {
  const id = requireIdentity(ctx.identity);
  const theme = themeFromCtx(ctx);
  const target = noteId(ctx);
  const note = ctx.store.getNote(target);
  if (!note) throw new CliError(`note #${target} not found`);
  if (flagBool(ctx.args, "undo")) {
    if (note.retiredAt === null) {
      ctx.out(`${theme.success("✓")} note #${target} isn't retired — nothing to undo\n`);
      return 0;
    }
    ctx.store.transaction(() => {
      const scratchpadId = ctx.repo.worktreeId
        ? (ctx.store.getScratchpadAttachment(id.key, ctx.repo.worktreeId)?.scratchpadId ?? null)
        : null;
      ctx.store.restoreNote(target);
      ctx.store.addActivity({
        sessionId: id.key,
        ts: ctx.now,
        kind: "forget",
        target: note.path,
        summary: `restored note #${target}: ${note.body}`,
        meta: null,
        worktreeId: ctx.repo.worktreeId,
        scratchpadId,
      });
      pruneAfterWrite(ctx.store, ctx.now);
    });
    ctx.out(`${theme.success("✓ restored")} note #${target}: ${note.body}\n`);
    return 0;
  }

  // Idempotent: an agent retrying a forget shouldn't error.
  if (note.retiredAt !== null) {
    ctx.out(
      `${theme.success("✓")} note #${target} is already retired${note.retireReason ? ` ${theme.dim(`(${note.retireReason})`)}` : ""}\n`,
    );
    return 0;
  }

  const reason = clamp(requireArg(rest(ctx.args, 2), "reason"));
  ctx.store.transaction(() => {
    const scratchpadId = ctx.repo.worktreeId
      ? (ctx.store.getScratchpadAttachment(id.key, ctx.repo.worktreeId)?.scratchpadId ?? null)
      : null;
    ctx.store.retireNote(target, id.key, reason, ctx.now);
    ctx.store.addActivity({
      sessionId: id.key,
      ts: ctx.now,
      kind: "forget",
      target: note.path,
      summary: `#${target}: ${reason}`,
      meta: null,
      worktreeId: ctx.repo.worktreeId,
      scratchpadId,
    });
    pruneAfterWrite(ctx.store, ctx.now);
  });
  ctx.out(`${theme.success("✓ retired")} note #${target} ${theme.dim("—")} ${reason}\n`);
  ctx.out(`${theme.dim(`  (recoverable: \`weaver forget --undo ${target}\`; history: \`weaver notes --all\`)`)}\n`);
  return 0;
}
