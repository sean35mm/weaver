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

test("deinit purge helper reports every removal failure", () => {
  const attempts: string[] = [];
  const failures = deinit.purgeStoreFiles("/store/repo.db", (file) => {
    attempts.push(file);
    if (file.endsWith("-wal")) throw new Error("permission denied");
  });
  assert.deepEqual(attempts, ["/store/repo.db", "/store/repo.db-wal", "/store/repo.db-shm", "/store/repo.db-journal"]);
  assert.deepEqual(failures, ["/store/repo.db-wal: permission denied"]);
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

test("uninstall preserves the binary when authored-data removal fails", () => {
  const root = tmpDir("weaver-uninstall-removal-failure-");
  const home = path.join(root, ".weaver");
  fs.mkdirSync(home, { mode: 0o700 });
  const binary = path.join(root, "weaver");
  fs.writeFileSync(binary, "standalone");
  const homeTarget = uninstall.inspectUninstallHome(home)!;
  const attempts: string[] = [];
  let out = "";
  let err = "";
  const result = uninstall.removeInstallFiles(
    { out: (text) => (out += text), err: (text) => (err += text) },
    home,
    binary,
    false,
    ((target: fs.PathLike) => {
      attempts.push(String(target));
      if (String(target) === home) throw new Error("permission denied");
    }) as typeof fs.rmSync,
    {
      binary: uninstall.inspectUninstallBinary(binary),
      defaultHome: home,
      home: homeTarget,
      recursiveHome: true,
    },
  );
  assert.equal(result, 1);
  assert.deepEqual(attempts, [home]);
  assert.match(err, /couldn't remove .*permission denied/);
  assert.doesNotMatch(out, /removed .*weaver/);
});

test("uninstall removes data before the binary after all removals succeed", () => {
  const root = tmpDir("weaver-uninstall-removal-order-");
  const home = path.join(root, ".weaver");
  fs.mkdirSync(home, { mode: 0o700 });
  const binary = path.join(root, "weaver");
  fs.writeFileSync(binary, "standalone");
  const attempts: string[] = [];
  const result = uninstall.removeInstallFiles(
    { out: () => undefined, err: () => undefined },
    home,
    binary,
    false,
    ((target: fs.PathLike) => attempts.push(String(target))) as typeof fs.rmSync,
    {
      binary: uninstall.inspectUninstallBinary(binary),
      defaultHome: home,
      home: uninstall.inspectUninstallHome(home),
      recursiveHome: true,
    },
  );
  assert.equal(result, 0);
  assert.deepEqual(attempts, [home, binary]);
});

test("uninstall home inspection rejects roots, symlinks, non-directories, unsafe modes, and owner mismatches", () => {
  const root = tmpDir("weaver-uninstall-targets-");
  const home = path.join(root, "home");
  const linked = path.join(root, "linked-home");
  const regularFile = path.join(root, "home-file");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.symlinkSync(home, linked);
  fs.writeFileSync(regularFile, "not a directory");

  assert.throws(() => uninstall.inspectUninstallHome(path.parse(root).root), /filesystem root/);
  assert.throws(() => uninstall.inspectUninstallHome(linked), /non-symlink directory/);
  assert.throws(() => uninstall.inspectUninstallHome(regularFile), /non-symlink directory/);
  fs.chmodSync(home, 0o722);
  assert.throws(() => uninstall.inspectUninstallHome(home), /group- or world-writable/);
  fs.chmodSync(home, 0o700);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  assert.throws(() => uninstall.inspectUninstallHome(home, { deps: { uid: uid + 1 } }), /not owned/);
});

test("uninstall binary inspection rejects symlinks and inode replacement before removal", () => {
  const root = tmpDir("weaver-uninstall-binary-");
  const realBinary = path.join(root, "weaver-real");
  const binary = path.join(root, "weaver");
  fs.writeFileSync(realBinary, "first");
  fs.symlinkSync(realBinary, binary);
  assert.throws(() => uninstall.inspectUninstallBinary(binary), /regular non-symlink/);

  fs.unlinkSync(binary);
  fs.writeFileSync(binary, "installed");
  const inspected = uninstall.inspectUninstallBinary(binary);
  const replacement = path.join(root, "replacement");
  fs.writeFileSync(replacement, "replacement");
  fs.renameSync(replacement, binary);
  const removals: string[] = [];
  let err = "";
  const result = uninstall.removeInstallFiles(
    { out: () => undefined, err: (text) => (err += text) },
    path.join(root, "unused-home"),
    binary,
    true,
    ((target: fs.PathLike) => removals.push(String(target))) as typeof fs.rmSync,
    { binary: inspected },
  );
  assert.equal(result, 1);
  assert.deepEqual(removals, []);
  assert.match(err, /changed during uninstall/);
  assert.equal(fs.readFileSync(binary, "utf8"), "replacement");
});

test("uninstall --keep-data validates and removes only the binary", async () => {
  const root = tmpDir("weaver-uninstall-keep-data-");
  const binary = path.join(root, "weaver");
  fs.writeFileSync(binary, "standalone");
  const ctx = await ctxFor(root, ["uninstall", "--yes", "--keep-data"], { WEAVER_HOME: path.parse(root).root });

  assert.equal(await uninstall.run(ctx, { execPath: binary }), 0);
  assert.equal(fs.existsSync(binary), false);
  assert.equal(fs.existsSync(path.parse(root).root), true);
  ctx.store.close();
});

test("full uninstall aborts before removing data or binary when the binary or parent is replaced after quiescence", async () => {
  for (const replacement of ["binary", "parent"] as const) {
    const root = tmpDir(`weaver-uninstall-${replacement}-race-`);
    const home = tmpDir("weaver-uninstall-race-home-");
    const binaryParent = path.join(root, "bin");
    const binary = path.join(binaryParent, "weaver");
    const dbPath = path.join(home, "repo.db");
    fs.mkdirSync(binaryParent);
    fs.writeFileSync(binary, "standalone");
    (await openStore(dbPath)).close();
    const ctx = await ctxFor(root, ["uninstall", "--yes"], { HOME: home, WEAVER_HOME: home });
    const removals: string[] = [];
    let replaced = false;

    const result = await uninstall.run(ctx, {
      dataSafety: {
        quiesce: async () => {
          if (!replaced) {
            replaced = true;
            if (replacement === "binary") {
              const nextBinary = path.join(root, "replacement");
              fs.writeFileSync(nextBinary, "replacement");
              fs.renameSync(nextBinary, binary);
            } else {
              const oldParent = path.join(root, "old-bin");
              fs.renameSync(binaryParent, oldParent);
              fs.mkdirSync(binaryParent);
              fs.renameSync(path.join(oldParent, "weaver"), binary);
            }
          }
          return { ok: true };
        },
      },
      execPath: binary,
      remove: ((target: fs.PathLike) => removals.push(String(target))) as typeof fs.rmSync,
    });

    assert.equal(result, 1, replacement);
    assert.deepEqual(removals, [], replacement);
    assert.equal(fs.existsSync(dbPath), true, replacement);
    assert.equal(fs.existsSync(binary), true, replacement);
    ctx.store.close();
  }
});

test("full uninstall selectively removes Weaver files from explicit WEAVER_HOME and preserves unrelated files", async () => {
  const root = tmpDir("weaver-uninstall-explicit-");
  const home = tmpDir("weaver-uninstall-user-home-");
  const binary = path.join(root, "weaver");
  const dbPath = path.join(home, "repo.db");
  const unrelated = path.join(home, "important.txt");
  fs.writeFileSync(binary, "standalone");
  fs.writeFileSync(unrelated, "preserve me");
  (await openStore(dbPath)).close();
  const ctx = await ctxFor(root, ["uninstall", "--yes"], { HOME: home, WEAVER_HOME: home });
  let out = "";
  ctx.out = (text) => {
    out += text;
  };

  assert.equal(await uninstall.run(ctx, { execPath: binary }), 0);
  assert.equal(fs.existsSync(binary), false);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me");
  assert.equal(fs.lstatSync(home).isDirectory(), true);
  assert.match(out, /left the directory and unrelated files intact/);
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
