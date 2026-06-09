import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { applyPostEdit, hookIdentity, parseHookPayload, preEditOutput } from "../src/commands/hook.ts";
import type { Ctx } from "../src/context.ts";
import {
  injectHooks,
  installHooks,
  removeHooks,
  settingsPathForRepo,
  uninstallHooks,
} from "../src/instructions/hooks.ts";
import { openStore } from "../src/store/open.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- settings.json merge/remove ----------

test("injectHooks adds pre/post entries and is idempotent", () => {
  const once = injectHooks({});
  const twice = injectHooks(once);
  assert.deepEqual(twice, once);

  const pre = once.hooks?.PreToolUse ?? [];
  const post = once.hooks?.PostToolUse ?? [];
  assert.equal(pre.length, 1);
  assert.equal(post.length, 1);
  assert.match(pre[0]?.hooks?.[0]?.command ?? "", /weaver hook pre-edit/);
  assert.match(post[0]?.hooks?.[0]?.command ?? "", /weaver hook post-edit/);
  // collaborators without weaver installed must get a silent no-op
  assert.match(pre[0]?.hooks?.[0]?.command ?? "", /command -v weaver/);
  assert.match(pre[0]?.hooks?.[0]?.command ?? "", /\|\| true/);
});

test("injectHooks/removeHooks preserve foreign hooks and unknown keys", () => {
  const settings = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "./lint.sh" }] }],
      SessionStart: [{ hooks: [{ type: "command" as const, command: "./hello.sh" }] }],
    },
  };
  const injected = injectHooks(settings);
  assert.deepEqual(injected.permissions, settings.permissions);
  assert.equal(injected.hooks?.PreToolUse?.length, 2); // foreign + ours
  assert.equal(injected.hooks?.SessionStart?.length, 1);

  const removed = removeHooks(injected);
  assert.deepEqual(removed, settings);
});

test("removeHooks drops an empty hooks object entirely", () => {
  const removed = removeHooks(injectHooks({}));
  assert.equal("hooks" in removed, false);
});

test("user hooks sharing a matcher group with weaver's entry survive remove and re-inject", () => {
  const injected = injectHooks({});
  // a user appends their own command to weaver's matcher group
  injected.hooks?.PreToolUse?.[0]?.hooks?.push({ type: "command", command: "./my-guard.sh" });

  const removed = removeHooks(injected);
  const survivors = removed.hooks?.PreToolUse ?? [];
  assert.equal(survivors.length, 1);
  assert.deepEqual(
    survivors[0]?.hooks?.map((h) => h.command),
    ["./my-guard.sh"],
  );
  assert.equal("PostToolUse" in (removed.hooks ?? {}), false); // ours-only list still drops

  // re-injecting dedupes our entry without disturbing the user's
  const reinjected = injectHooks(injected);
  const preGroups = reinjected.hooks?.PreToolUse ?? [];
  const commands = preGroups.flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.equal(commands.filter((c) => c.includes("weaver hook pre-edit")).length, 1);
  assert.ok(commands.includes("./my-guard.sh"));
});

test("installHooks/uninstallHooks round-trip on disk, refusing invalid JSON", () => {
  const root = tmpDir("weaver-hooks-");
  assert.equal(installHooks(root), "wrote");
  assert.equal(installHooks(root), "unchanged");

  const file = settingsPathForRepo(root);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(parsed.hooks.PreToolUse));

  assert.equal(uninstallHooks(root), "wrote");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});

  fs.writeFileSync(file, "{ not json");
  assert.equal(installHooks(root), "invalid-json");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json"); // never clobbered
});

// ---------- hook command core ----------

const HOST = os.hostname();

async function ctxFor(root: string): Promise<Ctx> {
  const store = await openStore(path.join(tmpDir("weaver-store-"), "s.db"));
  return {
    store,
    identity: null,
    repo: { repoId: "abc123", root, basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: root,
    now: 1_000_000,
    env: {},
    args: parseArgs(["hook", "pre-edit"]),
    out: () => {},
    err: () => {},
  };
}

test("parseHookPayload tolerates garbage", () => {
  assert.equal(parseHookPayload("not json"), null);
  assert.equal(parseHookPayload('"a string"'), null);
  assert.deepEqual(parseHookPayload('{"tool_name":"Edit"}'), { tool_name: "Edit" });
});

test("hookIdentity matches the harness identity the agent's own commands resolve", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));
  const id = hookIdentity(ctx, { session_id: "sess-1" });
  assert.equal(id?.key, `harness:claude-code:sess-1@${HOST}`);
  assert.equal(id?.label, "claude-code");
  ctx.store.close();
});

test("preEditOutput emits advisory allow JSON on a conflicting claim, silence when clear", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);

  ctx.store.upsertSession(
    { id: "explicit:alice@h", harness: "codex", idSource: "explicit", pid: null, cwd: null },
    ctx.now,
  );
  ctx.store.setIntent("explicit:alice@h", "auth refactor", ctx.now);
  ctx.store.addClaim({
    sessionId: "explicit:alice@h",
    pattern: "src/auth/**",
    reason: "token flow",
    createdAt: ctx.now,
    expiresAt: ctx.now + 60_000,
  });

  const payload = { session_id: "sess-1", cwd: root, tool_input: { file_path: path.join(root, "src/auth/login.ts") } };
  const output = preEditOutput(ctx, payload);
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow"); // advisory, never blocks
  assert.match(parsed.hookSpecificOutput.additionalContext, /src\/auth\/\*\*/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /token flow/);
  // no ANSI escapes inside the JSON payload
  assert.equal(parsed.hookSpecificOutput.additionalContext.includes("\u001b"), false);

  const clear = preEditOutput(ctx, { ...payload, tool_input: { file_path: path.join(root, "docs/readme.md") } });
  assert.equal(clear, null);

  // the claim holder's own edits must not warn about themselves
  ctx.store.upsertSession(
    { id: `harness:claude-code:sess-1@${HOST}`, harness: "claude-code", idSource: "harness", pid: null, cwd: null },
    ctx.now,
  );
  ctx.store.addClaim({
    sessionId: `harness:claude-code:sess-1@${HOST}`,
    pattern: "src/web/**",
    reason: null,
    createdAt: ctx.now,
    expiresAt: ctx.now + 60_000,
  });
  const own = preEditOutput(ctx, { ...payload, tool_input: { file_path: path.join(root, "src/web/app.ts") } });
  assert.equal(own, null);

  ctx.store.close();
});

test("preEditOutput ignores paths outside the repo and missing file_path", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);
  assert.equal(preEditOutput(ctx, { session_id: "s", tool_input: { file_path: "/etc/passwd" } }), null);
  assert.equal(preEditOutput(ctx, { session_id: "s", tool_input: {} }), null);
  assert.equal(preEditOutput(ctx, { session_id: "s" }), null);
  ctx.store.close();
});

test("applyPostEdit registers presence and logs the edit", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);

  const payload = { session_id: "sess-2", cwd: root, tool_input: { file_path: path.join(root, "src/app.ts") } };
  assert.equal(applyPostEdit(ctx, payload), true);

  const key = `harness:claude-code:sess-2@${HOST}`;
  const session = ctx.store.getSession(key);
  assert.equal(session?.harness, "claude-code");
  assert.equal(session?.lastSeen, ctx.now);

  const activity = ctx.store.listRecentActivity(5);
  assert.equal(activity[0]?.kind, "edit");
  assert.equal(activity[0]?.target, "src/app.ts");
  assert.equal(activity[0]?.sessionId, key);

  // no session id anywhere → nothing recorded
  assert.equal(applyPostEdit(ctx, { cwd: root, tool_input: { file_path: path.join(root, "b.ts") } }), false);

  ctx.store.close();
});
