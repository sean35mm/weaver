import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as deinit from "../src/commands/deinit.ts";
import * as doctor from "../src/commands/doctor.ts";
import * as init from "../src/commands/init.ts";
import * as toggle from "../src/commands/toggle.ts";
import * as uninstall from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { hasBlock, INSTRUCTION_BLOCK, injectBlock, instructionBlockStatus } from "../src/instructions/block.ts";
import { hookStatusGlobal, installHooks } from "../src/instructions/hooks.ts";
import {
  installOpencodePlugin,
  opencodePluginStatusForRepo,
  opencodePluginStatusGlobal,
} from "../src/instructions/opencode.ts";
import { openStore } from "../src/store/open.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function ctxFor(root: string, argv: string[] = [], env: Record<string, string | undefined> = {}): Promise<Ctx> {
  const store = await openStore(path.join(tmpDir("weaver-store-"), "s.db"));
  return {
    store,
    identity: { key: "explicit:me@h", source: "explicit", label: "test" },
    repo: { repoId: "abc123", root, basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: root,
    now: 1_000_000,
    env,
    args: parseArgs(argv),
    out: () => {},
    err: () => {},
  };
}

test("init injects the block into CLAUDE.md + AGENTS.md and enables", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root, ["init", "--project"]);
  await init.run(ctx);
  assert.ok(hasBlock(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")));
  assert.ok(hasBlock(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")));
  assert.equal(ctx.store.getMeta("enabled"), "1");
  ctx.store.close();
});

test("init is idempotent on the files", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root, ["init", "--project"]);
  await init.run(ctx);
  const first = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  await init.run(ctx);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), first);
  ctx.store.close();
});

test("init --global injects the block into global instruction files only", async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const codexHome = path.join(home, "codex-home");
  const ctx = await ctxFor(root, ["init", "--global"], {
    CODEX_HOME: codexHome,
    HOME: home,
  });
  await init.run(ctx);

  assert.ok(hasBlock(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")));
  assert.ok(hasBlock(fs.readFileSync(path.join(home, ".config", "opencode", "AGENTS.md"), "utf8")));
  assert.ok(hasBlock(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8")));
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
  assert.equal(ctx.store.getMeta("enabled"), "1");
  ctx.store.close();
});

test("init --global treats blank CODEX_HOME as unset", async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const ctx = await ctxFor(root, ["init", "--global"], { CODEX_HOME: "", HOME: home });
  await init.run(ctx);

  assert.ok(hasBlock(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8")));
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
  ctx.store.close();
});

test("init rejects project and global together", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root, ["init", "--project", "--global"]);
  let err = "";
  ctx.err = (s) => {
    err += s;
  };

  assert.equal(await init.run(ctx), 1);
  assert.match(err, /either --project or --global/);
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  ctx.store.close();
});

test("init rejects hooks and no-hooks together before touching any file", async () => {
  const root = tmpDir("weaver-repo-");
  const ctx = await ctxFor(root, ["init", "--project", "--hooks", "--no-hooks"]);
  let err = "";
  ctx.err = (s) => {
    err += s;
  };

  assert.equal(await init.run(ctx), 1);
  assert.match(err, /either --hooks or --no-hooks/);
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), false);
  assert.equal(ctx.store.getMeta("enabled"), undefined);
  ctx.store.close();
});

test("disable/enable toggles the enabled flag", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));
  toggle.runDisable(ctx);
  assert.equal(ctx.store.getMeta("enabled"), "0");
  toggle.runEnable(ctx);
  assert.equal(ctx.store.getMeta("enabled"), "1");
  ctx.store.close();
});

test("doctor reports setup coverage, weak identity, and stale state", async () => {
  const root = tmpDir("weaver-repo-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), injectBlock("# Agents\n"));
  const ctx = await ctxFor(root, ["doctor"], { HOME: tmpDir("weaver-home-") });
  ctx.identity = { key: "tty:ttys001@host", source: "ancestry", label: "opencode" };
  ctx.store.upsertSession(
    { id: "stale", harness: "opencode", idSource: "ancestry", pid: null, cwd: null },
    ctx.now - ctx.config.sessionTtlMs - 1,
  );
  ctx.store.addClaim({
    sessionId: "stale",
    pattern: "src/app.ts",
    reason: null,
    createdAt: ctx.now - ctx.config.claimTtlMs,
    expiresAt: ctx.now - 1,
  });
  let out = "";
  ctx.out = (s) => {
    out += s;
  };

  assert.equal(doctor.run(ctx), 0);
  // content matches only — the report's column layout is presentation, not contract
  assert.match(out, /weak \(ancestry\)/);
  assert.match(out, /1 unended session/);
  assert.match(out, /0 active, 1 expired open/);
  assert.match(out, /instructions 1\/2 current; missing CLAUDE\.md/);
  assert.match(out, /hooks[^\n]*missing/);
  assert.match(out, /plugin[^\n]*missing/);
  ctx.store.close();
});

test("doctor reports current project instructions and integrations", async () => {
  const root = tmpDir("weaver-repo-");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), injectBlock("# Claude\n"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), injectBlock("# Agents\n"));
  assert.equal(installHooks(root), "wrote");
  assert.equal(installOpencodePlugin(root), "wrote");
  const ctx = await ctxFor(root, ["doctor"], { HOME: tmpDir("weaver-home-") });
  let out = "";
  ctx.out = (s) => {
    out += s;
  };

  assert.equal(doctor.run(ctx), 0);
  assert.match(out, /instructions 2\/2 current/);
  assert.match(out, /hooks[^\n]*installed/);
  assert.match(out, /plugin[^\n]*current/);
  ctx.store.close();
});

test("deinit removes the block while preserving other content", async () => {
  const root = tmpDir("weaver-repo-");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Project\n\nimportant docs\n");
  const ctxA = await ctxFor(root, ["init", "--project"]);
  await init.run(ctxA);
  ctxA.store.close();

  const ctxB = await ctxFor(root);
  deinit.run(ctxB);
  ctxB.store.close();

  const txt = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(!hasBlock(txt));
  assert.ok(txt.includes("important docs"));
});

test("deinit --global removes global blocks", async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const env = { HOME: home };
  const claude = path.join(home, ".claude", "CLAUDE.md");
  const ctxA = await ctxFor(root, ["init", "--global"], env);
  await init.run(ctxA);
  ctxA.store.close();

  const ctxB = await ctxFor(root, ["deinit", "--global"], env);
  deinit.run(ctxB);
  ctxB.store.close();

  assert.ok(!hasBlock(fs.readFileSync(claude, "utf8")));
});

test("uninstall refuses when not running the standalone binary", async () => {
  const root = tmpDir("weaver-repo-");
  let err = "";
  const base = await ctxFor(root, ["uninstall", "--yes"]);
  const ctx = {
    ...base,
    err: (s: string) => {
      err += s;
    },
  };

  assert.equal(await uninstall.run(ctx), 1);
  assert.match(err, /only applies to the standalone/);
  ctx.store.close();
});

test("init --hooks installs the OpenCode plugin; deinit removes it", async () => {
  const root = tmpDir("weaver-repo-");
  const ctxA = await ctxFor(root, ["init", "--project", "--hooks"]);
  await init.run(ctxA);
  assert.equal(opencodePluginStatusForRepo(root), "current");
  ctxA.store.close();

  const ctxB = await ctxFor(root, ["deinit"]);
  deinit.run(ctxB);
  assert.equal(opencodePluginStatusForRepo(root), "missing");
  ctxB.store.close();
});

test("init --global --hooks installs global integrations; deinit --global removes them", async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const env = { HOME: home, CODEX_HOME: path.join(home, "codex-home") };

  const ctxA = await ctxFor(root, ["init", "--global", "--hooks"], env);
  await init.run(ctxA);
  ctxA.store.close();

  // global files exist; nothing was written into the repo
  assert.equal(hookStatusGlobal(env), "installed");
  assert.equal(opencodePluginStatusGlobal(env), "current");
  assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json")));
  assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "plugins", "weaver.js")));
  assert.equal(fs.existsSync(path.join(root, ".claude")), false);
  assert.equal(fs.existsSync(path.join(root, ".opencode")), false);

  // project deinit leaves global integrations alone
  const ctxB = await ctxFor(root, ["deinit"], env);
  deinit.run(ctxB);
  ctxB.store.close();
  assert.equal(hookStatusGlobal(env), "installed");
  assert.equal(opencodePluginStatusGlobal(env), "current");

  const ctxC = await ctxFor(root, ["deinit", "--global"], env);
  deinit.run(ctxC);
  ctxC.store.close();
  assert.equal(hookStatusGlobal(env), "missing");
  assert.equal(opencodePluginStatusGlobal(env), "missing");
});

test("init refreshes stale managed blocks and plugin without changing user content", async () => {
  const root = tmpDir("weaver-repo-");
  const stale = INSTRUCTION_BLOCK.replace("protocol=3", "protocol=2").replace("scratchpads-first", "legacy");
  fs.writeFileSync(path.join(root, "AGENTS.md"), `# User heading\n\nkeep before\n\n${stale}\n\nkeep after\n`);
  fs.mkdirSync(path.join(root, ".opencode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "plugins", "weaver.js"), "// weaver:opencode-plugin protocol=1\n");

  const ctx = await ctxFor(root, ["init", "--project", "--hooks"]);
  await init.run(ctx);

  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal(instructionBlockStatus(agents), "current");
  assert.match(agents, /^# User heading\n\nkeep before/);
  assert.match(agents, /keep after\n$/);
  assert.equal(opencodePluginStatusForRepo(root), "current");
  ctx.store.close();
});

test("doctor reports outdated protocol files with scope-correct refresh commands", async () => {
  const root = tmpDir("weaver-repo-");
  const stale = INSTRUCTION_BLOCK.replace("protocol=3", "protocol=2");
  fs.writeFileSync(path.join(root, "AGENTS.md"), stale);
  fs.mkdirSync(path.join(root, ".opencode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "plugins", "weaver.js"), "// weaver:opencode-plugin protocol=1\n");
  const ctx = await ctxFor(root, ["doctor"], { HOME: tmpDir("weaver-home-") });
  let out = "";
  ctx.out = (text) => {
    out += text;
  };

  assert.equal(doctor.run(ctx), 0);
  assert.match(out, /outdated AGENTS\.md.*weaver init --project/);
  assert.match(out, /plugin[^\n]*project outdated[^\n]*weaver init --project --hooks/);
  ctx.store.close();
});

test("doctor reports foreign managed artifacts without claiming init will overwrite them", async () => {
  const root = tmpDir("weaver-repo-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "<!-- weaver:start custom -->\nuser block\n<!-- weaver:end -->\n");
  fs.mkdirSync(path.join(root, ".opencode", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "plugins", "weaver.js"),
    "export const UserPlugin = async () => ({});\n",
  );
  const ctx = await ctxFor(root, ["doctor"], { HOME: tmpDir("weaver-home-") });
  let out = "";
  ctx.out = (text) => {
    out += text;
  };

  assert.equal(doctor.run(ctx), 0);
  assert.match(out, /foreign AGENTS\.md.*init will not overwrite it/);
  assert.match(out, /plugin[^\n]*project foreign[^\n]*init will not overwrite it/);
  ctx.store.close();
});
