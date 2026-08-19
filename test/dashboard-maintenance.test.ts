import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  acquireDashboardMaintenance,
  isDashboardMaintenanceActive,
  quiesceDashboard,
} from "../src/dashboard/maintenance.ts";
import { registerStoreHolder } from "../src/store/coordination.ts";
import type { DashboardLeaseRow } from "../src/store/store.ts";

const temporaryDirectories: string[] = [];

function runtimeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dashboard-maintenance-"));
  temporaryDirectories.push(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("dashboard maintenance adapter uses the generalized per-store fence", async () => {
  const home = runtimeDirectory();
  const holder = await registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir: home, command: "seed" });
  await holder.release();
  const maintenance = await acquireDashboardMaintenance({
    repoId: "repo",
    weaverHome: home,
    tmpDir: home,
    reason: "purge",
  });
  assert.equal(maintenance.acquired, true);
  if (!maintenance.acquired) return;
  assert.equal(await isDashboardMaintenanceActive({ runtimeDirectory: holder.runtime.storeDirectory }), true);
  await assert.rejects(
    registerStoreHolder({ repoId: "repo", weaverHome: home, tmpDir: home, command: "blocked" }),
    /maintenance/,
  );
  await Promise.all([maintenance.release(), maintenance.release()]);
  assert.equal(await isDashboardMaintenanceActive({ runtimeDirectory: holder.runtime.storeDirectory }), false);
});

function lease(overrides: Partial<DashboardLeaseRow> = {}): DashboardLeaseRow {
  return {
    scopeId: "scope",
    ownerId: "owner",
    ownerPid: 321,
    renewedAt: 1_000,
    expiresAt: 20_000,
    ...overrides,
  };
}

test("quiescence treats shutdown as acceptance and waits for lease and socket teardown", async () => {
  const directory = runtimeDirectory();
  const current = lease();
  let reads = 0;
  let now = 1_000;
  const result = await quiesceDashboard({
    store: {
      getDashboardLease: () => (reads++ < 2 ? current : undefined),
      releaseDashboardLease: () => false,
    },
    repoId: "repo",
    scopeId: "scope",
    runtimeDirectory: directory,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    isProcessAlive: () => reads < 3,
    requestControl: async () => ({
      protocol: 1,
      repoId: "repo",
      ownerId: "owner",
      state: "shutting-down",
      ok: true,
    }),
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(reads >= 3);
});

test("quiescence fails closed on timeout and successor ownership", async () => {
  const directory = runtimeDirectory();
  const current = lease();
  let now = 1_000;
  const timeout = await quiesceDashboard({
    store: { getDashboardLease: () => current, releaseDashboardLease: () => false },
    repoId: "repo",
    scopeId: "scope",
    runtimeDirectory: directory,
    timeoutMs: 100,
    pollMs: 50,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    isProcessAlive: () => true,
    requestControl: async () => ({
      protocol: 1,
      repoId: "repo",
      ownerId: "owner",
      state: "shutting-down",
      ok: true,
    }),
  });
  assert.deepEqual(timeout, { ok: false, error: "dashboard shutdown timed out" });

  let successor = false;
  const changed = await quiesceDashboard({
    store: {
      getDashboardLease: () => (successor ? lease({ ownerId: "successor" }) : current),
      releaseDashboardLease: () => false,
    },
    repoId: "repo",
    scopeId: "scope",
    runtimeDirectory: directory,
    sleep: async () => {
      successor = true;
    },
    isProcessAlive: () => true,
    requestControl: async () => ({
      protocol: 1,
      repoId: "repo",
      ownerId: "owner",
      state: "shutting-down",
      ok: true,
    }),
  });
  assert.deepEqual(changed, { ok: false, error: "dashboard ownership changed during maintenance" });
});

test("quiescence recovers only a definitively dead exact lease", async () => {
  const directory = runtimeDirectory();
  let current: DashboardLeaseRow | undefined = lease();
  const released: string[] = [];
  const result = await quiesceDashboard({
    store: {
      getDashboardLease: () => current,
      releaseDashboardLease: (scopeId, ownerId) => {
        released.push(`${scopeId}:${ownerId}`);
        if (current?.scopeId !== scopeId || current.ownerId !== ownerId) return false;
        current = undefined;
        return true;
      },
    },
    repoId: "repo",
    scopeId: "scope",
    runtimeDirectory: directory,
    isProcessAlive: () => false,
    requestControl: async () => {
      throw new Error("missing socket");
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(released, ["scope:owner"]);

  const blocked = await quiesceDashboard({
    store: { getDashboardLease: () => lease(), releaseDashboardLease: () => true },
    repoId: "repo",
    scopeId: "scope",
    runtimeDirectory: directory,
    isProcessAlive: () => undefined,
    requestControl: async () => {
      throw new Error("unresponsive");
    },
  });
  assert.deepEqual(blocked, { ok: false, error: "dashboard owner did not accept shutdown" });
});
