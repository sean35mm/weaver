import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as deinit from "../src/commands/deinit.ts";
import * as init from "../src/commands/init.ts";
import * as toggle from "../src/commands/toggle.ts";
import type { Ctx } from "../src/context.ts";
import { hasBlock } from "../src/instructions/block.ts";
import { openStore } from "../src/store/open.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function ctxFor(
  root: string,
  argv: string[] = [],
  env: Record<string, string | undefined> = {},
): Promise<Ctx> {
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
  assert.ok(
    hasBlock(fs.readFileSync(path.join(home, ".config", "opencode", "AGENTS.md"), "utf8")),
  );
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

test("disable/enable toggles the enabled flag", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));
  toggle.runDisable(ctx);
  assert.equal(ctx.store.getMeta("enabled"), "0");
  toggle.runEnable(ctx);
  assert.equal(ctx.store.getMeta("enabled"), "1");
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
