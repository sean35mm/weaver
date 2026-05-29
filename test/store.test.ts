import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openStore } from "../src/store/open.ts";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-test-"));
  return path.join(dir, "store.db");
}

const NOW = 1_000_000;
const TTL = 5 * 60 * 1000;

test("sessions: round-trip, intent, active filtering, end", async () => {
  const store = await openStore(tmpDb());

  store.upsertSession({ id: "s1", harness: "claude-code", idSource: "harness", pid: 7, cwd: "/x" }, NOW);
  store.setIntent("s1", "refactor auth", NOW);

  const got = store.getSession("s1");
  assert.equal(got?.harness, "claude-code");
  assert.equal(got?.idSource, "harness");
  assert.equal(got?.intent, "refactor auth");

  assert.equal(store.listActiveSessions(NOW, TTL).length, 1);
  // stale once last_seen falls outside the TTL
  assert.equal(store.listActiveSessions(NOW + 10 * 60 * 1000, TTL).length, 0);

  store.endSession("s1", NOW + 1);
  assert.equal(store.listActiveSessions(NOW + 1, TTL).length, 0);

  store.close();
});

test("claims: active, expiry, release", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);

  store.addClaim({
    sessionId: "s1",
    pattern: "src/auth/**",
    reason: "tokens",
    createdAt: NOW,
    expiresAt: NOW + 30 * 60 * 1000,
  });

  assert.equal(store.listActiveClaims(NOW).length, 1);
  assert.equal(store.listActiveClaims(NOW + 31 * 60 * 1000).length, 0); // expired

  store.releaseClaim("s1", "src/auth/**", NOW + 1);
  assert.equal(store.listActiveClaims(NOW + 1).length, 0);

  store.close();
});

test("notes: pinned first, newest first", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);

  store.addNote({ sessionId: "s1", harness: "opencode", body: "pinned-one", path: null, tags: null, pinned: true, createdAt: NOW, supersedes: null });
  store.addNote({ sessionId: "s1", harness: "opencode", body: "newer-plain", path: null, tags: null, pinned: false, createdAt: NOW + 5, supersedes: null });

  const notes = store.listNotes(10);
  assert.equal(notes.length, 2);
  assert.equal(notes[0]?.pinned, true);
  assert.equal(notes[0]?.body, "pinned-one");

  store.close();
});

test("activity: insert, recent order, prune to maxEvents", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "pi", idSource: "tty", pid: null, cwd: null }, NOW);

  for (let i = 0; i < 5; i++) {
    store.addActivity({ sessionId: "s1", ts: NOW + i, kind: "edit", target: `f${i}.ts`, summary: "x", meta: null });
  }
  const recent = store.listRecentActivity(10);
  assert.equal(recent.length, 5);
  assert.equal(recent[0]?.target, "f4.ts"); // newest first

  store.pruneActivity({ maxEvents: 2, maxAgeDays: 365, now: NOW + 100 });
  assert.equal(store.listRecentActivity(10).length, 2);

  store.close();
});

test("meta: schema_version seeded, get/set upsert", async () => {
  const store = await openStore(tmpDb());
  assert.equal(store.getMeta("schema_version"), "1");

  store.setMeta("enabled", "1");
  assert.equal(store.getMeta("enabled"), "1");
  store.setMeta("enabled", "0");
  assert.equal(store.getMeta("enabled"), "0");

  store.close();
});
