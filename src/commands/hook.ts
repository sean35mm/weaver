/**
 * Claude Code hook endpoint: `weaver hook pre-edit|post-edit`, payload JSON on stdin.
 *
 * pre-edit (PreToolUse) is advisory — it always allows the edit, but when another live
 * session claims or recently touched the same area it injects a warning the model sees.
 * post-edit (PostToolUse) records the edit and refreshes this session's heartbeat, so an
 * agent that edits for a long stretch without running weaver commands stays visibly live.
 *
 * Contract: NEVER break the agent. Any problem — unparseable stdin, missing store, paths
 * outside the repo, internal errors — exits 0 with no output.
 */

import fs from "node:fs";
import path from "node:path";
import { detectConflict } from "../conflict.ts";
import type { Ctx } from "../context.ts";
import { type Identity, resolveIdentity } from "../identity/session.ts";
import { formatConflict } from "../render.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { plainTheme } from "../terminal/color.ts";
import { pruneAfterWrite } from "./prune.ts";

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown };
}

export function parseHookPayload(raw: string): HookPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as HookPayload;
  } catch {
    return null;
  }
}

/**
 * Identity must match what the agent's own weaver commands resolve, or hook events would
 * register a phantom second session. Hooks run with no TTY, so we rebuild the same ladder
 * with the payload's session_id injected as the harness-native id.
 */
export function hookIdentity(ctx: Ctx, payload: HookPayload): Identity | null {
  const env =
    typeof payload.session_id === "string" && payload.session_id
      ? { ...ctx.env, CLAUDE_CODE_SESSION_ID: payload.session_id }
      : ctx.env;
  // No TTY rung: hook processes have no controlling terminal, and walking ancestry here
  // could mint an identity that doesn't match the agent's own weaver commands.
  return resolveIdentity({ env, argv: [], ttyResolver: () => null });
}

/**
 * Resolve symlinked ancestors via the deepest existing directory (e.g. macOS `/tmp` →
 * `/private/tmp`), so payload paths compare against the physical repo root. The file itself
 * may not exist yet — Write fires the hook before creating it.
 */
function realpathLenient(p: string): string {
  let head = p;
  let tail = "";
  for (;;) {
    try {
      return tail ? path.join(fs.realpathSync.native(head), tail) : fs.realpathSync.native(head);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
      head = parent;
    }
  }
}

function targetPath(ctx: Ctx, payload: HookPayload): string | null {
  const filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const root = realpathLenient(ctx.repo.root);
    const cwd = realpathLenient(typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ctx.cwd);
    return normalizeTarget(path.isAbsolute(filePath) ? realpathLenient(filePath) : filePath, root, cwd);
  } catch {
    return null; // outside the repo (or malformed) — not ours to comment on
  }
}

/** The advisory JSON for PreToolUse, or null when there is nothing worth saying. */
export function preEditOutput(ctx: Ctx, payload: HookPayload): string | null {
  const target = targetPath(ctx, payload);
  if (!target) return null;
  const self = hookIdentity(ctx, payload);

  // Keep a quietly-working agent visibly live (same semantics as `weaver check`).
  if (self) {
    const session = ctx.store.getSession(self.key);
    if (session && session.endedAt === null) ctx.store.touchSession(self.key, ctx.now);
  }

  const conflict = detectConflict({
    store: ctx.store,
    target,
    selfId: self?.key ?? null,
    now: ctx.now,
    sessionTtlMs: ctx.config.sessionTtlMs,
    recentMs: ctx.config.recentMs,
  });
  if (conflict.tier !== "hard" && conflict.tier !== "soft") return null;

  const summary = formatConflict(conflict, ctx.now, plainTheme).trimEnd();
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Weaver: another agent is active in this area (advisory).",
      additionalContext: `weaver: ${payload.tool_input?.file_path} overlaps another active session.\n${summary}\nCoordinate or ask the user before overwriting their work; \`weaver status\` has the full picture.`,
    },
  })}\n`;
}

/** Record the edit + heartbeat. Returns true when something was written. */
export function applyPostEdit(ctx: Ctx, payload: HookPayload): boolean {
  const target = targetPath(ctx, payload);
  const self = hookIdentity(ctx, payload);
  if (!target || !self) return false;

  ctx.store.transaction(() => {
    ctx.store.upsertSession(
      { id: self.key, harness: self.label, idSource: self.source, pid: null, cwd: ctx.cwd },
      ctx.now,
    );
    ctx.store.addActivity({ sessionId: self.key, ts: ctx.now, kind: "edit", target, summary: null, meta: null });
    pruneAfterWrite(ctx.store, ctx.now);
  });
  return true;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(ctx: Ctx): Promise<number> {
  try {
    const event = ctx.args._[1];
    if (event !== "pre-edit" && event !== "post-edit") return 0;
    if (process.stdin.isTTY) return 0; // hooks never run on a TTY; don't hang a curious human
    if ((ctx.store.getMeta("enabled") ?? "1") === "0") return 0;

    const payload = parseHookPayload(await readStdin());
    if (!payload) return 0;

    if (event === "pre-edit") {
      const output = preEditOutput(ctx, payload);
      if (output) ctx.out(output);
    } else {
      applyPostEdit(ctx, payload);
    }
  } catch {
    /* advisory plumbing must never break the agent */
  }
  return 0;
}
