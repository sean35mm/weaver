import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/store/db.ts";
import { EmptyStore } from "../src/store/empty.ts";
import { openStore } from "../src/store/open.ts";
import { SCHEMA_VERSION } from "../src/store/schema.ts";
import type { DashboardLeaseInput } from "../src/store/store.ts";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dashboard-lease-"));
  return path.join(dir, "store.db");
}

const START = 1_000;

function lease(
  scopeId: string,
  ownerId: string,
  renewedAt: number,
  expiresAt: number,
  ownerPid = 101,
): DashboardLeaseInput {
  return { scopeId, ownerId, ownerPid, renewedAt, expiresAt };
}

test("dashboard leases contend within one scope but coexist across scopes", async () => {
  const dbPath = tmpDb();
  const first = await openStore(dbPath);
  const second = await openStore(dbPath);

  assert.equal(first.tryAcquireDashboardLease(lease("scope-a", "first", START, START + 100)), true);
  assert.equal(second.tryAcquireDashboardLease(lease("scope-a", "second", START, START + 100, 202)), false);
  assert.equal(second.tryAcquireDashboardLease(lease("scope-b", "other", START, START + 100, 303)), true);
  assert.deepEqual(second.getDashboardLease("scope-a"), lease("scope-a", "first", START, START + 100));
  assert.deepEqual(first.getDashboardLease("scope-b"), lease("scope-b", "other", START, START + 100, 303));

  assert.equal(second.tryAcquireDashboardLease(lease("scope-a", "second", START + 99, START + 199, 202)), false);
  assert.equal(second.tryAcquireDashboardLease(lease("scope-a", "second", START + 100, START + 200, 202)), true);
  assert.deepEqual(first.getDashboardLease("scope-a"), lease("scope-a", "second", START + 100, START + 200, 202));

  first.close();
  second.close();
});

test("scope and owner gate renewal and release without timestamp regression", async () => {
  const dbPath = tmpDb();
  const first = await openStore(dbPath);
  const second = await openStore(dbPath);

  assert.equal(first.tryAcquireDashboardLease(lease("scope", "old", START, START + 10)), true);
  assert.equal(second.tryAcquireDashboardLease(lease("scope", "successor", START + 10, START + 110, 202)), true);
  assert.equal(first.renewDashboardLease(lease("scope", "old", START + 11, START + 111)), false);
  assert.equal(first.releaseDashboardLease("scope", "old"), false);
  assert.equal(second.renewDashboardLease(lease("other", "successor", START + 20, START + 150, 202)), false);

  assert.equal(second.renewDashboardLease(lease("scope", "successor", START + 20, START + 150, 202)), true);
  assert.equal(second.renewDashboardLease(lease("scope", "successor", START + 19, START + 160, 202)), false);
  assert.deepEqual(first.getDashboardLease("scope"), lease("scope", "successor", START + 20, START + 150, 202));
  assert.equal(second.releaseDashboardLease("scope", "successor"), true);
  assert.equal(first.getDashboardLease("scope"), undefined);
  assert.equal(second.releaseDashboardLease("scope", "successor"), false);

  first.close();
  second.close();
});

test("dashboard lease requires renewal before expiry", async () => {
  const store = await openStore(tmpDb());
  assert.equal(store.tryAcquireDashboardLease(lease("scope", "owner", START, START + 10)), true);
  assert.equal(store.renewDashboardLease(lease("scope", "owner", START + 10, START + 20)), false);
  store.close();
});

test("schema-v5 migration adds scoped dashboard leases and remains idempotent", async () => {
  const dbPath = tmpDb();
  const raw = await openDb(dbPath);
  raw.exec(`
    CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO weaver_meta (key, value) VALUES ('schema_version', '5');
  `);
  raw.close();

  const migrated = await openStore(dbPath);
  assert.equal(migrated.getMeta("schema_version"), String(SCHEMA_VERSION));
  assert.equal(migrated.tryAcquireDashboardLease(lease("scope", "owner", START, START + 10)), true);
  migrated.close();

  const reopened = await openStore(dbPath);
  assert.deepEqual(reopened.getDashboardLease("scope"), lease("scope", "owner", START, START + 10));
  reopened.close();
});

test("unreleased fixed-row v6 dashboard lease is replaced by scoped v6 schema", async () => {
  const dbPath = tmpDb();
  const raw = await openDb(dbPath);
  raw.exec(`
    CREATE TABLE dashboard_leases (
      id INTEGER PRIMARY KEY CHECK (id = 1), owner_id TEXT NOT NULL,
      renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    INSERT INTO dashboard_leases VALUES (1, 'legacy', 1, 2);
    CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO weaver_meta (key, value) VALUES ('schema_version', '6');
  `);
  raw.close();

  const migrated = await openStore(dbPath);
  assert.equal(migrated.getDashboardLease("scope"), undefined);
  assert.equal(migrated.tryAcquireDashboardLease(lease("scope", "owner", START, START + 10)), true);
  migrated.close();
});

test("empty store exposes no lease and rejects lease writes", () => {
  const store = new EmptyStore();
  const input = lease("scope", "owner", START, START + 10);

  assert.equal(store.getDashboardLease("scope"), undefined);
  assert.throws(() => store.tryAcquireDashboardLease(input), /read-only empty store cannot be written/);
  assert.throws(() => store.renewDashboardLease(input), /read-only empty store cannot be written/);
  assert.throws(() => store.releaseDashboardLease("scope", "owner"), /read-only empty store cannot be written/);
});
