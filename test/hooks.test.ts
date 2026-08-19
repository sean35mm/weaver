import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../src/args.ts";
import { applyPostEdit, hookIdentity, parseHookPayload, preEditOutput } from "../src/commands/hook.ts";
import type { Ctx } from "../src/context.ts";
import {
  globalSettingsPath,
  hookStatusForRepo,
  hookStatusGlobal,
  injectHooks,
  installHooks,
  installHooksGlobal,
  removeHooks,
  settingsPathForRepo,
  uninstallHooks,
  uninstallHooksGlobal,
} from "../src/instructions/hooks.ts";
import {
  installOpencodePlugin,
  installOpencodePluginGlobal,
  OPENCODE_PLUGIN_PROTOCOL_VERSION,
  opencodePluginPathForRepo,
  opencodePluginPathGlobal,
  opencodePluginStatusForRepo,
  opencodePluginStatusGlobal,
  PLUGIN_SOURCE,
  uninstallOpencodePlugin,
  uninstallOpencodePluginGlobal,
} from "../src/instructions/opencode.ts";
import { openStore } from "../src/store/open.ts";
import { DEFAULT_ADVISORY_COOLDOWN_MS } from "../src/store/reap.ts";

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
  assert.equal(hookStatusForRepo(root), "missing");
  assert.equal(installHooks(root), "wrote");
  assert.equal(installHooks(root), "unchanged");
  assert.equal(hookStatusForRepo(root), "installed");

  const file = settingsPathForRepo(root);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(parsed.hooks.PreToolUse));

  assert.equal(uninstallHooks(root), "wrote");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  assert.equal(hookStatusForRepo(root), "missing");

  fs.writeFileSync(file, "{ not json");
  assert.equal(installHooks(root), "invalid-json");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json"); // never clobbered
  assert.equal(hookStatusForRepo(root), "invalid-json");
});

test("hookStatusForRepo distinguishes partial hook installs", () => {
  const root = tmpDir("weaver-hooks-");
  const file = settingsPathForRepo(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "weaver hook pre-edit" }] }] } })}\n`,
  );

  assert.equal(hookStatusForRepo(root), "partial");
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
  ctx.repo.worktreeId = "wt-a";
  ctx.store.upsertSession(
    {
      id: `harness:claude-code:sess-1@${HOST}`,
      harness: "claude-code",
      idSource: "harness",
      pid: null,
      cwd: null,
      worktreeId: "wt-a",
    },
    ctx.now,
  );
  ctx.store.addClaim({
    sessionId: `harness:claude-code:sess-1@${HOST}`,
    pattern: "src/web/**",
    reason: null,
    createdAt: ctx.now,
    expiresAt: ctx.now + 60_000,
    worktreeId: "wt-a",
  });
  const own = preEditOutput(ctx, { ...payload, tool_input: { file_path: path.join(root, "src/web/app.ts") } });
  assert.equal(own, null);

  ctx.store.close();
});

test("preEditOutput rate-limits repeat warnings, re-warns on a changed picture or after cooldown", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);
  const longTtl = ctx.now + 60 * 60 * 1000;

  ctx.store.upsertSession(
    { id: "explicit:alice@h", harness: "codex", idSource: "explicit", pid: null, cwd: null },
    ctx.now,
  );
  ctx.store.addClaim({
    sessionId: "explicit:alice@h",
    pattern: "src/auth/**",
    reason: "token flow",
    createdAt: ctx.now,
    expiresAt: longTtl,
  });

  const payload = { session_id: "sess-9", cwd: root, tool_input: { file_path: path.join(root, "src/auth/login.ts") } };
  assert.ok(preEditOutput(ctx, payload)); // first edit warns
  assert.equal(preEditOutput(ctx, payload), null); // same picture within cooldown: silent
  // a different file under the same claim is the same picture — still silent
  const sibling = { ...payload, tool_input: { file_path: path.join(root, "src/auth/token.ts") } };
  assert.equal(preEditOutput(ctx, sibling), null);

  // the picture changes (a second claimant appears) → re-warn immediately
  ctx.store.upsertSession({ id: "explicit:bob@h", harness: "pi", idSource: "explicit", pid: null, cwd: null }, ctx.now);
  ctx.store.addClaim({
    sessionId: "explicit:bob@h",
    pattern: "src/auth/login.ts",
    reason: null,
    createdAt: ctx.now,
    expiresAt: longTtl,
  });
  assert.ok(preEditOutput(ctx, payload));

  // after the cooldown, the same picture warns again
  const later = { ...ctx, now: ctx.now + DEFAULT_ADVISORY_COOLDOWN_MS + 1 };
  ctx.store.touchSession("explicit:alice@h", later.now); // keep the holders live
  ctx.store.touchSession("explicit:bob@h", later.now);
  assert.ok(preEditOutput(later, payload));
  assert.equal(preEditOutput(later, payload), null); // and rate-limits again

  ctx.store.close();
});

test("preEditOutput permits a different worktree with isolated-files wording", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);
  ctx.repo.worktreeId = "wt-a";
  ctx.store.upsertSession(
    { id: "other", harness: "codex", idSource: "explicit", pid: null, cwd: null, worktreeId: "wt-b" },
    ctx.now,
  );
  ctx.store.addClaim({
    sessionId: "other",
    pattern: "src/auth/**",
    reason: "token flow",
    createdAt: ctx.now,
    expiresAt: ctx.now + 60_000,
    worktreeId: "wt-b",
  });
  const output = preEditOutput(ctx, {
    session_id: "sess-worktree",
    cwd: root,
    tool_input: { file_path: path.join(root, "src/auth/login.ts") },
  });
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(parsed.hookSpecificOutput.additionalContext, /checkouts are isolated/i);
  ctx.store.close();
});

test("preEditOutput keeps a reused identity in another worktree informational", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);
  ctx.repo.worktreeId = "wt-a";
  const id = `harness:claude-code:sess-worktree@${HOST}`;
  ctx.store.upsertSession(
    { id, harness: "claude-code", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-b" },
    ctx.now,
  );
  ctx.store.addClaim({
    sessionId: id,
    pattern: "src/auth/**",
    reason: "token flow",
    createdAt: ctx.now,
    expiresAt: ctx.now + 60_000,
    worktreeId: "wt-b",
  });

  const output = preEditOutput(ctx, {
    session_id: "sess-worktree",
    cwd: root,
    tool_input: { file_path: path.join(root, "src/auth/login.ts") },
  });
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.match(parsed.hookSpecificOutput.additionalContext, /different worktree/i);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /CONFLICT/);
  ctx.store.close();
});

test("preEditOutput includes blocking and informational worktree context together", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root);
  ctx.repo.worktreeId = "wt-a";
  for (const [id, worktreeId] of [
    ["blocker", "wt-a"],
    ["other", "wt-b"],
  ] as const) {
    ctx.store.upsertSession({ id, harness: "codex", idSource: "explicit", pid: null, cwd: null, worktreeId }, ctx.now);
    ctx.store.addClaim({
      sessionId: id,
      pattern: "src/auth/**",
      reason: null,
      createdAt: ctx.now,
      expiresAt: ctx.now + 60_000,
      worktreeId,
    });
  }

  const output = preEditOutput(ctx, {
    session_id: "sess-mixed",
    cwd: root,
    tool_input: { file_path: path.join(root, "src/auth/login.ts") },
  });
  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.match(parsed.hookSpecificOutput.additionalContext, /CONFLICT/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /OTHER WORKTREE/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /files are isolated/i);
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

// ---------- OpenCode identity plugin install/remove ----------

test("opencode plugin: install writes the marked file, is idempotent, refreshes stale content", () => {
  const root = tmpDir("weaver-oc-");
  assert.equal(opencodePluginStatusForRepo(root), "missing");

  assert.equal(installOpencodePlugin(root), "wrote");
  assert.equal(opencodePluginStatusForRepo(root), "current");
  assert.equal(installOpencodePlugin(root), "unchanged");

  const file = opencodePluginPathForRepo(root);
  assert.equal(fs.readFileSync(file, "utf8"), PLUGIN_SOURCE);
  assert.match(PLUGIN_SOURCE, /shell\.env/);
  assert.match(PLUGIN_SOURCE, /OPENCODE_SESSION_ID/);
  assert.match(PLUGIN_SOURCE, /import \{ tool \} from "@opencode-ai\/plugin"/);
  assert.equal(OPENCODE_PLUGIN_PROTOCOL_VERSION, 4);

  // a stale (older-template) weaver file is refreshed as long as it carries the marker
  fs.writeFileSync(file, "// weaver:opencode-plugin — old template\n");
  assert.equal(opencodePluginStatusForRepo(root), "outdated");
  assert.equal(installOpencodePlugin(root), "wrote");
  assert.equal(fs.readFileSync(file, "utf8"), PLUGIN_SOURCE);
});

test("opencode plugin: a user-owned weaver.js is never written over or removed", () => {
  const root = tmpDir("weaver-oc-");
  const file = opencodePluginPathForRepo(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const MyPlugin = async () => ({});\n");

  assert.equal(opencodePluginStatusForRepo(root), "foreign");
  assert.equal(installOpencodePlugin(root), "foreign");
  assert.equal(uninstallOpencodePlugin(root), "foreign");
  assert.equal(fs.readFileSync(file, "utf8"), "export const MyPlugin = async () => ({});\n");

  fs.writeFileSync(
    file,
    "// user-owned plugin mentioning weaver:opencode-plugin\nexport const MyPlugin = async () => ({});\n",
  );
  assert.equal(opencodePluginStatusForRepo(root), "foreign");
  assert.equal(installOpencodePlugin(root), "foreign");
  assert.equal(uninstallOpencodePlugin(root), "foreign");
});

test("opencode plugin: uninstall removes our file and no-ops when missing", () => {
  const root = tmpDir("weaver-oc-");
  assert.equal(uninstallOpencodePlugin(root), "unchanged");

  installOpencodePlugin(root);
  assert.equal(uninstallOpencodePlugin(root), "wrote");
  assert.equal(fs.existsSync(opencodePluginPathForRepo(root)), false);
  assert.equal(opencodePluginStatusForRepo(root), "missing");
});

test("global scope: hooks and plugin install under HOME, uninstall cleanly", () => {
  const env = { HOME: tmpDir("weaver-ghome-") };

  assert.equal(hookStatusGlobal(env), "missing");
  assert.equal(installHooksGlobal(env), "wrote");
  assert.equal(hookStatusGlobal(env), "installed");
  assert.ok(fs.existsSync(globalSettingsPath(env)));
  assert.equal(uninstallHooksGlobal(env), "wrote");
  assert.equal(hookStatusGlobal(env), "missing");

  assert.equal(opencodePluginStatusGlobal(env), "missing");
  assert.equal(installOpencodePluginGlobal(env), "wrote");
  assert.equal(opencodePluginStatusGlobal(env), "current");
  assert.equal(fs.readFileSync(opencodePluginPathGlobal(env), "utf8"), PLUGIN_SOURCE);
  assert.match(opencodePluginPathGlobal(env), /\.config\/opencode\/plugins\/weaver\.js$/);
  assert.equal(uninstallOpencodePluginGlobal(env), "wrote");
  assert.equal(opencodePluginStatusGlobal(env), "missing");
});

test("hookIdentity honors the payload's harness and rejects unknown ones", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));

  const opencode = hookIdentity(ctx, { session_id: "ses_abc", harness: "opencode" });
  assert.equal(opencode?.key, `harness:opencode:ses_abc@${HOST}`);
  assert.equal(opencode?.label, "opencode");

  // the payload wins over ambient harness env vars regardless of registry precedence
  ctx.env = { CLAUDE_CODE_SESSION_ID: "stray" };
  const overridden = hookIdentity(ctx, { session_id: "ses_abc", harness: "opencode" });
  assert.equal(overridden?.key, `harness:opencode:ses_abc@${HOST}`);

  assert.equal(hookIdentity(ctx, { session_id: "x", harness: "not-a-harness" }), null);
  ctx.store.close();
});

test("plugin template parses as ESM and its hooks guard correctly", async () => {
  const dir = tmpDir("weaver-oc-tpl-");
  const file = path.join(dir, "weaver-plugin.mjs");
  const stub = path.join(dir, "node_modules", "@opencode-ai", "plugin");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(
    path.join(stub, "index.js"),
    `const schema = () => { const value = {}; for (const name of ["int", "positive", "min", "max", "optional"]) value[name] = () => value; return value; };
export function tool(spec) { return spec; }
tool.schema = { string: schema, number: schema, boolean: schema, enum: schema };
`,
  );
  fs.writeFileSync(file, PLUGIN_SOURCE);
  const mod = (await import(pathToFileURL(file).href)) as {
    WeaverPlugin: (input: { directory: string; worktree?: string }) => Promise<Record<string, unknown>>;
  };
  assert.equal(typeof mod.WeaverPlugin, "function");
  const hooks = (await mod.WeaverPlugin({ directory: dir })) as {
    tool: Record<
      string,
      { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string> }
    >;
    "shell.env": (input: Record<string, unknown>, output: { env: Record<string, string> }) => Promise<void>;
    "tool.execute.after": (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;
    event: (input: Record<string, unknown>) => Promise<void>;
  };
  assert.equal(
    await mod.WeaverPlugin({ directory: dir }),
    hooks,
    "simultaneous global/project loads share one repo runtime",
  );
  assert.notEqual(
    await mod.WeaverPlugin({ directory: `${dir}-other` }),
    hooks,
    "global plugin still serves other repos",
  );
  assert.match(PLUGIN_SOURCE, /max\(4000\)/);
  assert.doesNotMatch(PLUGIN_SOURCE, /cwd: directory \|\| worktree,\n\s*tool_input/);

  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "weaver_fact_forget",
    "weaver_fact_record",
    "weaver_facts_list",
    "weaver_scratchpad_archive",
    "weaver_scratchpad_create",
    "weaver_scratchpad_edit_section",
    "weaver_scratchpad_list",
    "weaver_scratchpad_read",
    "weaver_scratchpad_recover",
    "weaver_scratchpad_rename",
    "weaver_scratchpad_restore",
    "weaver_scratchpad_trash",
    "weaver_scratchpad_use",
  ]);

  // shell.env exports the session id
  const env: Record<string, string> = {};
  await hooks["shell.env"]({ sessionID: "ses_1" }, { env });
  assert.equal(env.OPENCODE_SESSION_ID, "ses_1");
  await hooks["shell.env"]({}, { env: {} }); // no session id → no write, no throw

  // non-edit tools, missing paths, and missing session ids never touch tool output
  const out = { title: "t", output: "original", metadata: {} };
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_1", callID: "c", args: { filePath: "x" } }, out);
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_1", callID: "c", args: {} }, out);
  await hooks["tool.execute.after"]({ tool: "write", callID: "c", args: { filePath: "x" } }, out);
  assert.equal(out.output, "original");

  // unrelated events are ignored
  await hooks.event({ event: { type: "session.updated", properties: {} } });
  await hooks.event({ event: { type: "session.deleted", properties: {} } }); // no id → no-op
});

test("project and global OpenCode hook objects deduplicate edit and deletion invocations", async () => {
  const dir = tmpDir("weaver-oc-dedup-");
  const projectFile = path.join(dir, "project-plugin.mjs");
  const globalFile = path.join(dir, "global-plugin.mjs");
  const stub = path.join(dir, "node_modules", "@opencode-ai", "plugin");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(
    path.join(stub, "index.js"),
    `const schema = () => { const value = {}; for (const name of ["int", "positive", "min", "max", "optional"]) value[name] = () => value; return value; };
export function tool(spec) { return spec; }
tool.schema = { string: schema, number: schema, boolean: schema, enum: schema };
`,
  );
  fs.writeFileSync(projectFile, PLUGIN_SOURCE);
  fs.writeFileSync(globalFile, PLUGIN_SOURCE);

  const calls: string[][] = [];
  let now = 10_000;
  const spawn = (argv: string[]) => {
    calls.push(argv);
    const stdout =
      argv[1] === "hook" && argv[2] === "pre-edit"
        ? JSON.stringify({ hookSpecificOutput: { additionalContext: "claim warning" } })
        : "";
    return { stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(0) };
  };
  const globals = globalThis as typeof globalThis & { Bun?: { spawn: typeof spawn } };
  const originalBun = globals.Bun;
  const originalSpawn = originalBun?.spawn;
  if (originalBun) originalBun.spawn = spawn;
  else globals.Bun = { spawn };
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const [projectModule, globalModule] = (await Promise.all([
      import(`${pathToFileURL(projectFile).href}?scope=project`),
      import(`${pathToFileURL(globalFile).href}?scope=global`),
    ])) as Array<{
      WeaverPlugin: (input: { directory: string }) => Promise<{
        "tool.execute.after": (input: Record<string, unknown>, output: { output: string }) => Promise<void>;
        event: (input: Record<string, unknown>) => Promise<void>;
      }>;
    }>;
    assert.ok(projectModule);
    assert.ok(globalModule);
    const project = await projectModule.WeaverPlugin({ directory: dir });
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("weaver.opencode.plugin.runtime.v4")];
    const global = await globalModule.WeaverPlugin({ directory: dir });
    assert.notEqual(project, global, "the test exercises distinct hook objects as OpenCode does");

    const input = { tool: "edit", sessionID: "ses_dedup", callID: "call_1", args: { filePath: "src/app.ts" } };
    const projectOutput = { output: "project" };
    const globalOutput = { output: "global" };
    await Promise.all([
      project["tool.execute.after"](input, projectOutput),
      global["tool.execute.after"](input, globalOutput),
    ]);
    assert.deepEqual(calls, [
      ["weaver", "hook", "post-edit"],
      ["weaver", "hook", "pre-edit"],
    ]);
    assert.match(projectOutput.output, /claim warning/);
    assert.match(globalOutput.output, /claim warning/);

    await project["tool.execute.after"]({ ...input, callID: "call_2" }, { output: "later" });
    assert.equal(calls.length, 4, "a later edit with a distinct call id is not suppressed");
    now += 501;
    await project["tool.execute.after"](input, { output: "same call later" });
    assert.equal(calls.length, 6, "the short TTL does not suppress a legitimate later replay");

    const deleted = { event: { type: "session.deleted", properties: { info: { id: "ses_dedup" } } } };
    await Promise.all([project.event(deleted), global.event(deleted)]);
    assert.equal(calls.filter((argv) => argv[1] === "done").length, 1);
  } finally {
    Date.now = originalNow;
    if (originalBun && originalSpawn) originalBun.spawn = originalSpawn;
    else delete globals.Bun;
  }
});

test("OpenCode tools use fixed JSON argv, stdin bodies, execute context, and strict errors", async () => {
  const dir = tmpDir("weaver-oc-tools-");
  const file = path.join(dir, "plugin.mjs");
  const stub = path.join(dir, "node_modules", "@opencode-ai", "plugin");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(
    path.join(stub, "index.js"),
    `const schema = () => { const value = {}; for (const name of ["int", "positive", "min", "max", "optional"]) value[name] = () => value; return value; };
export function tool(spec) { return spec; }
tool.schema = { string: schema, number: schema, boolean: schema, enum: schema };
`,
  );
  fs.writeFileSync(file, PLUGIN_SOURCE);

  const calls: Array<{ argv: string[]; opts: Record<string, unknown> }> = [];
  let result = { stdout: '[{"id":1}]\n', stderr: "", code: 0 };
  const spawn = (argv: string[], opts: Record<string, unknown>) => {
    calls.push({ argv, opts });
    return {
      stdout: new Response(result.stdout).body,
      stderr: new Response(result.stderr).body,
      exited: Promise.resolve(result.code),
    };
  };
  const globals = globalThis as typeof globalThis & { Bun?: { spawn: typeof spawn } };
  const originalBun = globals.Bun;
  const originalSpawn = originalBun?.spawn;
  if (originalBun) originalBun.spawn = spawn;
  else globals.Bun = { spawn };

  try {
    const mod = (await import(`${pathToFileURL(file).href}?strict=1`)) as {
      WeaverPlugin: (input: { directory: string; worktree?: string }) => Promise<{
        tool: Record<
          string,
          { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string> }
        >;
      }>;
    };
    const plugin = await mod.WeaverPlugin({ directory: "/plugin-directory", worktree: "/plugin-worktree" });
    const listed = await plugin.tool.weaver_scratchpad_list?.execute(
      { state: "archived", limit: 7 },
      { sessionID: "ses_tools", directory: "/execute-directory" },
    );
    assert.equal(listed, '[{"id":1}]');
    assert.deepEqual(calls[0]?.argv, ["weaver", "scratchpad", "list", "--state=archived", "--limit=7", "--json"]);
    assert.equal(calls[0]?.opts.cwd, "/execute-directory");
    assert.equal((calls[0]?.opts.env as Record<string, string>).OPENCODE_SESSION_ID, "ses_tools");

    const abort = new AbortController().signal;
    result = { stdout: '{"id":2}\n', stderr: "", code: 0 };
    await plugin.tool.weaver_scratchpad_create?.execute(
      { title: "Auth workstream", body: "# Decisions\n\nKeep this curated.\n" },
      { sessionID: "ses_tools", abort },
    );
    assert.deepEqual(calls[1]?.argv, ["weaver", "scratchpad", "create", "Auth workstream", "--from=-", "--json"]);
    assert.equal(new TextDecoder().decode(calls[1]?.opts.stdin as Uint8Array), "# Decisions\n\nKeep this curated.\n");
    assert.equal(calls[1]?.opts.cwd, "/plugin-directory");
    assert.equal(calls[1]?.opts.signal, abort);

    result = {
      stdout: "",
      stderr: "weaver: stale scratchpad revision: expected 2, current is 3\n",
      code: 1,
    };
    const archive = plugin.tool.weaver_scratchpad_archive;
    assert.ok(archive);
    await assert.rejects(
      archive.execute({ id: 4, expectedRevision: 2 }, { sessionID: "ses_tools", worktree: "/execute-worktree" }),
      /Weaver revision conflict:.*expected 2, current is 3/,
    );
    assert.deepEqual(calls[2]?.argv, ["weaver", "scratchpad", "archive", "4", "--revision=2", "--json"]);

    result = { stdout: "", stderr: "x".repeat(20_000), code: 2 };
    await assert.rejects(archive.execute({ id: 4, expectedRevision: 3 }, { sessionID: "ses_tools" }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exit 2/);
      assert.match(error.message, /output truncated by Weaver OpenCode integration/);
      assert.ok(error.message.length < 17_000);
      return true;
    });
  } finally {
    if (originalBun && originalSpawn) originalBun.spawn = originalSpawn;
    else delete globals.Bun;
  }
});
