import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  acquireHomeMaintenance,
  acquireStoreMaintenance,
  drainStoreHolders,
  getProcessStartId,
  isMaintenanceActive,
  registerStoreHolder,
} from "../src/store/coordination.ts";
import { storeRuntimePaths } from "../src/store/runtime.ts";

const temporaryDirectories: string[] = [];

function scope(prefix = "weaver-coordination-"): { root: string; home: string; tmpDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const tmpDir = path.join(root, "runtime");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmpDir, { mode: 0o700 });
  return { root, home, tmpDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("holder admission publishes private metadata before store creation and releases exactly", async () => {
  const { home, tmpDir } = scope();
  const holder = await registerStoreHolder({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    command: "task secret-session-must-not-be-metadata",
    randomId: () => "holder-a",
  });
  assert.equal(fs.existsSync(holder.runtime.storePath), false);
  const file = path.join(holder.runtime.holdersDirectory, ".holder-holder-a.json");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), [
    "command",
    "createdAt",
    "holderId",
    "pid",
    "processStartId",
    "protocol",
    "repoId",
  ]);
  assert.equal(metadata.holderId, "holder-a");
  assert.equal(metadata.repoId, "repo");
  assert.equal((fs.lstatSync(file).mode & 0o777).toString(8), "600");
  await Promise.all([holder.release(), holder.release()]);
  assert.deepEqual(fs.readdirSync(holder.runtime.holdersDirectory), []);
});

test("an active store or home fence rejects admission before the DB exists", async () => {
  for (const kind of ["store", "home"] as const) {
    const { home, tmpDir } = scope(`weaver-coordination-${kind}-`);
    const fence =
      kind === "store"
        ? await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge" })
        : await acquireHomeMaintenance({ weaverHome: home, tmpDir, reason: "uninstall" });
    assert.equal(fence.acquired, true);
    try {
      await assert.rejects(
        registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir, command: "task blocked" }),
        /maintenance/,
      );
      assert.equal(fs.existsSync(path.join(home, "repo.db")), false);
    } finally {
      if (fence.acquired) await fence.release();
    }
  }
});

test("holder/fence race either admits a drainable holder or rejects it", async () => {
  const { home, tmpDir } = scope();
  const admission = registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir, command: "task race" }).then(
    (holder) => ({ holder }),
    (error: Error) => ({ error }),
  );
  const maintenance = await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge" });
  assert.equal(maintenance.acquired, true);
  if (!maintenance.acquired) return;
  const result = await admission;
  if ("holder" in result) {
    await result.holder.release();
    assert.deepEqual(await drainStoreHolders(maintenance, result.holder.runtime), { ok: true });
  } else {
    assert.match(result.error.message, /maintenance/);
  }
  await maintenance.release();
});

test("home and store maintenance cross-race never leave both fences active", async () => {
  const { home, tmpDir } = scope();
  const seed = await registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir, command: "seed" });
  await seed.release();
  const [homeFence, storeFence] = await Promise.all([
    acquireHomeMaintenance({ weaverHome: home, tmpDir, reason: "uninstall", randomId: () => "home" }),
    acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge", randomId: () => "store" }),
  ]);
  assert.equal(homeFence.acquired && storeFence.acquired, false);
  if (homeFence.acquired) await homeFence.release();
  if (storeFence.acquired) await storeFence.release();
});

test("draining reclaims absent or PID-reused holders but waits for matching birth identity", async () => {
  const { home, tmpDir } = scope();
  const stale = await registerStoreHolder({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    command: "stale",
    pid: 4242,
    processStartId: () => "birth-a",
  });
  const fence = await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge" });
  assert.equal(fence.acquired, true);
  if (!fence.acquired) return;
  assert.deepEqual(await drainStoreHolders(fence, stale.runtime, { inspectProcess: () => "reused" }), { ok: true });
  await fence.release();

  const live = await registerStoreHolder({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    command: "live",
    pid: 4242,
    processStartId: () => "birth-b",
  });
  const next = await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge" });
  assert.equal(next.acquired, true);
  if (!next.acquired) return;
  let now = 0;
  const blocked = await drainStoreHolders(next, live.runtime, {
    timeoutMs: 10,
    pollMs: 10,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    inspectProcess: () => "matching",
  });
  assert.deepEqual(blocked, { ok: false, error: "timed out waiting for store holders to close" });
  await live.release();
  await next.release();
});

test("indeterminate, malformed, symlink, and wrong-mode holder metadata fail closed", async () => {
  for (const defect of ["indeterminate", "malformed", "symlink", "mode"] as const) {
    const { home, tmpDir } = scope(`weaver-coordination-${defect}-`);
    const holder = await registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir, command: defect });
    if (defect === "malformed")
      fs.writeFileSync(path.join(holder.runtime.holdersDirectory, ".holder-bad.json"), "{", { mode: 0o600 });
    if (defect === "symlink") {
      fs.symlinkSync(
        path.join(holder.runtime.holdersDirectory, `.holder-${holder.metadata.holderId}.json`),
        path.join(holder.runtime.holdersDirectory, ".holder-linked.json"),
      );
    }
    if (defect === "mode") {
      fs.chmodSync(path.join(holder.runtime.holdersDirectory, `.holder-${holder.metadata.holderId}.json`), 0o644);
    }
    const fence = await acquireStoreMaintenance({ repoId: "repo", weaverHome: home, tmpDir, reason: "purge" });
    assert.equal(fence.acquired, true);
    if (!fence.acquired) continue;
    const drained = await drainStoreHolders(fence, holder.runtime, { inspectProcess: () => "indeterminate" });
    assert.equal(drained.ok, false);
    await fence.release();
    await holder.release().catch(() => undefined);
  }
});

test("a stale fence release cannot remove its successor", async () => {
  const { home, tmpDir } = scope();
  const stale = await acquireStoreMaintenance({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    reason: "purge",
    pid: 111,
    processStartId: () => "old",
    randomId: () => "stale",
  });
  assert.equal(stale.acquired, true);
  const successor = await acquireStoreMaintenance({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    reason: "purge",
    randomId: () => "successor",
    inspectProcess: () => "reused",
  });
  assert.equal(successor.acquired, true);
  if (!stale.acquired || !successor.acquired) return;
  await stale.release();
  assert.equal(await isMaintenanceActive(successor.directory), true);
  await successor.release();
  assert.equal(await isMaintenanceActive(successor.directory), false);
});

test("a reclaimed stale holder handle cannot unlink a same-metadata successor", async () => {
  const { home, tmpDir } = scope();
  const holderOptions = {
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    command: "same command",
    pid: 4242,
    now: () => 1,
    processStartId: () => "same-process",
    randomId: () => "reused-id",
  };
  const stale = await registerStoreHolder(holderOptions);
  const fence = await acquireStoreMaintenance({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    reason: "purge",
    processStartId: () => "maintenance",
  });
  assert.equal(fence.acquired, true);
  if (!fence.acquired) return;
  assert.deepEqual(await drainStoreHolders(fence, stale.runtime, { inspectProcess: () => "reused" }), { ok: true });
  await fence.release();

  const successor = await registerStoreHolder(holderOptions);
  await assert.rejects(stale.release(), /ownership changed/);
  assert.equal(fs.existsSync(path.join(successor.runtime.holdersDirectory, ".holder-reused-id.json")), true);
  await successor.release();
});

test("symlinked home aliases converge while different homes and UIDs are isolated", () => {
  const { root, home, tmpDir } = scope();
  const alias = path.join(root, "alias");
  fs.symlinkSync(home, alias, "dir");
  const direct = storeRuntimePaths({ repoId: "repo", weaverHome: home, tmpDir, uid: 501 });
  const linked = storeRuntimePaths({ repoId: "repo", weaverHome: alias, tmpDir, uid: 501 });
  const otherHome = storeRuntimePaths({ repoId: "repo", weaverHome: path.join(root, "other"), tmpDir, uid: 501 });
  const otherUid = storeRuntimePaths({ repoId: "repo", weaverHome: home, tmpDir, uid: 502 });
  assert.equal(direct.storeDirectory, linked.storeDirectory);
  assert.notEqual(direct.storeDirectory, otherHome.storeDirectory);
  assert.notEqual(direct.storeDirectory, otherUid.storeDirectory);
});

test("production coordination roots ignore TMPDIR while explicit test roots remain injectable", () => {
  const { root, home } = scope();
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = path.join(root, "environment-a");
    const first = storeRuntimePaths({ repoId: "repo", weaverHome: home, uid: 501 });
    process.env.TMPDIR = path.join(root, "environment-b");
    const second = storeRuntimePaths({ repoId: "repo", weaverHome: home, uid: 501 });
    const injected = storeRuntimePaths({ repoId: "repo", weaverHome: home, uid: 501, tmpDir: root });
    assert.equal(first.storeDirectory, second.storeDirectory);
    assert.ok(first.storeDirectory.startsWith(`${fs.realpathSync.native("/tmp")}${path.sep}`));
    assert.ok(injected.storeDirectory.startsWith(`${fs.realpathSync.native(root)}${path.sep}`));
    assert.throws(() => storeRuntimePaths({ repoId: "repo", weaverHome: home, uid: null }), /numeric user id/);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("released holders and maintenance generations retain bounded coordination artifacts", {
  timeout: 30_000,
}, async () => {
  const { home, tmpDir } = scope();
  let sequence = 0;
  let runtime: Awaited<ReturnType<typeof registerStoreHolder>>["runtime"] | undefined;
  for (let index = 0; index < 300; index += 1) {
    const holder = await registerStoreHolder({
      repoId: "repo",
      weaverHome: home,
      tmpDir,
      command: "high frequency",
      processStartId: () => "test-process",
      randomId: () => `holder-${index}`,
    });
    runtime = holder.runtime;
    await holder.release();
  }
  assert.ok(runtime);
  assert.deepEqual(fs.readdirSync(runtime.holdersDirectory), []);

  for (let index = 0; index < 300; index += 1) {
    const fence = await acquireStoreMaintenance({
      repoId: "repo",
      weaverHome: home,
      tmpDir,
      reason: "purge",
      processStartId: () => "test-process",
      randomId: () => `fence-${sequence++}`,
    });
    assert.equal(fence.acquired, true);
    if (fence.acquired) await fence.release();
  }
  const artifacts = fs
    .readdirSync(runtime.storeDirectory)
    .filter((name) => name.startsWith(".maintenance-") || name.startsWith(".holder-"));
  assert.ok(artifacts.length <= 6, `expected bounded coordination artifacts, found ${artifacts.length}`);
  assert.equal(
    artifacts.some((name) => name.includes("owner")),
    false,
  );
});

test("draining tolerates holders disappearing together during a release race", { timeout: 30_000 }, async () => {
  const { home, tmpDir } = scope();
  const holders = await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      registerStoreHolder({
        repoId: "repo",
        weaverHome: home,
        tmpDir,
        command: "release race",
        processStartId: () => "test-process",
        randomId: () => `race-${index}`,
      }),
    ),
  );
  const fence = await acquireStoreMaintenance({
    repoId: "repo",
    weaverHome: home,
    tmpDir,
    reason: "purge",
    processStartId: () => "test-process",
  });
  assert.equal(fence.acquired, true);
  if (!fence.acquired) return;
  let now = 0;
  let released = false;
  const drained = await drainStoreHolders(fence, holders[0]!.runtime, {
    timeoutMs: 10,
    pollMs: 1,
    now: () => now,
    inspectProcess: () => "matching",
    sleep: async (ms) => {
      now += ms;
      if (!released) {
        released = true;
        await Promise.all(holders.map((holder) => holder.release()));
      }
    },
  });
  assert.deepEqual(drained, { ok: true });
  assert.deepEqual(fs.readdirSync(holders[0]!.runtime.holdersDirectory), []);
  await fence.release();
});

test("process birth identity is available when the platform exposes it", () => {
  const identity = getProcessStartId(process.pid);
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(typeof identity, "string");
    assert.ok(identity && identity.length > 8);
  }
});
