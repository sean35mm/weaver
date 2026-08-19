import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { run as runDeinit } from "../src/commands/deinit.ts";
import { prepareUninstallDataRemoval } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import {
  acquireHomeMaintenance,
  acquireStoreMaintenance,
  drainStoreHolders,
  inventoryHomeStoreIds,
  registerStoreHolder,
  runtimeForHomeStore,
} from "../src/store/coordination.ts";
import { openDb } from "../src/store/db.ts";
import { EmptyStore } from "../src/store/empty.ts";
import { openStore } from "../src/store/open.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function context(home: string, repoId: string, args: string[], withStore = true): Promise<Ctx> {
  const root = temporaryDirectory("weaver-destructive-repo-");
  if (!withStore) {
    return {
      store: new EmptyStore(),
      storeHome: undefined,
      storePath: undefined,
      storeHolder: null,
      identity: null,
      repo: { repoId, root, basis: "path" },
      config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
      cwd: root,
      now: 1_000,
      env: { WEAVER_HOME: home },
      args: parseArgs(args),
      out: () => undefined,
      err: () => undefined,
    };
  }
  const holder = await registerStoreHolder({ repoId, weaverHome: home, command: args.join(" ") });
  const store = await openStore(holder.runtime.storePath);
  return {
    store,
    storeHome: holder.runtime.canonicalHome,
    storePath: holder.runtime.storePath,
    storeHolder: holder,
    identity: null,
    repo: { repoId, root, basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: root,
    now: 1_000,
    env: { WEAVER_HOME: home },
    args: parseArgs(args),
    out: () => undefined,
    err: () => undefined,
  };
}

test("deinit purge refuses deletion while another maintenance owner holds the store fence", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  const ctx = await context(home, "repo", ["deinit", "--purge"]);
  const held = await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, reason: "purge" });
  assert.equal(held.acquired, true);
  try {
    assert.equal(await runDeinit(ctx), 1);
    assert.equal(fs.existsSync(path.join(home, "repo.db")), true);
  } finally {
    if (held.acquired) await held.release();
    ctx.store.close();
    await ctx.storeHolder?.release();
  }
});

test("home uninstall fence blocks per-store maintenance until explicit release", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  for (const repoId of ["a", "b"]) (await openStore(path.join(home, `${repoId}.db`))).close();
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);
  const held = await prepareUninstallDataRemoval(ctx, home);
  assert.ok(held);
  try {
    for (const repoId of ["a", "b"]) {
      const contender = await acquireStoreMaintenance({ repoId, weaverHome: home, reason: "purge" });
      assert.equal(contender.acquired, false);
    }
  } finally {
    await held?.release();
  }
});

test("uninstall data safety releases its home fence after quiescence failure", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  for (const repoId of ["a", "b"]) (await openStore(path.join(home, `${repoId}.db`))).close();
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);
  let inspected = 0;
  const result = await prepareUninstallDataRemoval(ctx, home, {
    acquireMaintenance: acquireHomeMaintenance,
    drainHolders: drainStoreHolders,
    inventory: inventoryHomeStoreIds,
    openStore,
    quiesce: async () => (++inspected === 2 ? { ok: false, error: "dashboard shutdown timed out" } : { ok: true }),
    runtimeForStore: runtimeForHomeStore,
  });
  assert.equal(result, undefined);
  assert.equal(fs.existsSync(path.join(home, "a.db")), true);
  assert.equal(fs.existsSync(path.join(home, "b.db")), true);
  const next = await acquireHomeMaintenance({ weaverHome: home, reason: "uninstall" });
  assert.equal(next.acquired, true);
  if (next.acquired) await next.release();
});

test("home uninstall refuses an existing active per-store fence", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  (await openStore(path.join(home, "a.db"))).close();
  const runtimeHolder = await registerStoreHolder({ repoId: "a", weaverHome: home, command: "setup" });
  await runtimeHolder.release();
  const storeFence = await acquireStoreMaintenance({ repoId: "a", weaverHome: home, reason: "purge" });
  assert.equal(storeFence.acquired, true);
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);
  try {
    assert.equal(await prepareUninstallDataRemoval(ctx, home), undefined);
    assert.equal(fs.existsSync(path.join(home, "a.db")), true);
  } finally {
    if (storeFence.acquired) await storeFence.release();
  }
});

test("home uninstall drains a pre-fence holder that creates its DB later and inspects it on rescan", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  const holder = await registerStoreHolder({ repoId: "late", weaverHome: home, command: "late writer" });
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);
  let opened = 0;
  const lateWrite = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void (async () => {
        try {
          (await openStore(holder.runtime.storePath)).close();
          await holder.release();
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    }, 20);
  });
  const maintenance = await prepareUninstallDataRemoval(ctx, home, {
    acquireMaintenance: acquireHomeMaintenance,
    drainHolders: drainStoreHolders,
    inventory: inventoryHomeStoreIds,
    openStore: async (dbPath, options) => {
      opened += 1;
      return openStore(dbPath, options);
    },
    quiesce: async () => ({ ok: true }),
    runtimeForStore: runtimeForHomeStore,
  });
  await lateWrite;
  assert.ok(maintenance);
  assert.ok(opened >= 1, "the DB created while draining was inspected during the stable rescan");
  await maintenance?.release();
});

test("home uninstall refuses a planted DB symlink without touching its external target", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  const outside = temporaryDirectory("weaver-destructive-outside-");
  const target = path.join(outside, "target.db");
  fs.writeFileSync(target, "external database bytes");
  const before = fs.readFileSync(target);
  fs.symlinkSync(target, path.join(home, "planted.db"));
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);
  let error = "";
  ctx.err = (text) => {
    error += text;
  };

  assert.equal(await prepareUninstallDataRemoval(ctx, home), undefined);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(fs.lstatSync(path.join(home, "planted.db")).isSymbolicLink(), true);
  assert.match(error, /unsafe store file/);
});

test("home uninstall refuses a nonregular DB inventory entry", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  const nonregular = path.join(home, "planted.db");
  fs.mkdirSync(nonregular);
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);

  assert.equal(await prepareUninstallDataRemoval(ctx, home), undefined);
  assert.equal(fs.lstatSync(nonregular).isDirectory(), true);
});

test("home uninstall rejects an unknown SQLite store without modifying it", async () => {
  const home = temporaryDirectory("weaver-destructive-home-");
  const dbPath = path.join(home, "unknown.db");
  const db = await openDb(dbPath);
  db.exec("CREATE TABLE unrelated (value TEXT NOT NULL); INSERT INTO unrelated VALUES ('preserve me')");
  db.close();
  const before = fs.readFileSync(dbPath);
  const ctx = await context(home, "current", ["uninstall", "--yes"], false);

  assert.equal(await prepareUninstallDataRemoval(ctx, home), undefined);
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
});
