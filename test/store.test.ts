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

test("sessions: recent ended sessions honor cutoff", async () => {
  const store = await openStore(tmpDb());

  store.upsertSession({ id: "old", harness: "claude-code", idSource: "harness", pid: null, cwd: null }, NOW);
  store.endSession("old", NOW + 1);
  store.upsertSession({ id: "recent", harness: "claude-code", idSource: "harness", pid: null, cwd: null }, NOW + 10);
  store.endSession("recent", NOW + 20);

  assert.deepEqual(
    store.listRecentEndedSessions(10, NOW + 10).map((s) => s.id),
    ["recent"],
  );

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

test("claims: prune old expired claims but keep recent stale claims", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  const day = 24 * 60 * 60 * 1000;

  store.addClaim({
    sessionId: "s1",
    pattern: "old/**",
    reason: null,
    createdAt: NOW - 10 * day,
    expiresAt: NOW - 8 * day,
  });
  store.addClaim({
    sessionId: "s1",
    pattern: "recent/**",
    reason: null,
    createdAt: NOW - 2 * day,
    expiresAt: NOW - day,
  });
  store.addClaim({ sessionId: "s1", pattern: "active/**", reason: null, createdAt: NOW, expiresAt: NOW + day });

  store.pruneClaims({ maxAgeDays: 7, now: NOW });

  assert.deepEqual(
    store.listOpenClaims().map((c) => c.pattern),
    ["recent/**", "active/**"],
  );

  store.close();
});

test("transaction rolls back related writes", async () => {
  const store = await openStore(tmpDb());

  assert.throws(() => {
    store.transaction(() => {
      store.upsertSession({ id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
      throw new Error("boom");
    });
  }, /boom/);

  assert.equal(store.getSession("s1"), undefined);
  store.close();
});

test("transaction rejects nested and async callbacks", async () => {
  const store = await openStore(tmpDb());
  let asyncInvoked = false;

  assert.throws(() => {
    store.transaction(() => store.transaction(() => undefined));
  }, /nested transactions/);
  assert.throws(() => {
    store.transaction(() => Promise.resolve("later"));
  }, /async transactions/);
  assert.throws(() => {
    store.transaction(async () => {
      asyncInvoked = true;
      await Promise.resolve();
      store.upsertSession({ id: "late", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
    });
  }, /async transactions/);

  assert.equal(asyncInvoked, false);
  assert.equal(store.getSession("late"), undefined);
  store.close();
});

test("notes: pinned first, newest first", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);

  store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "pinned-one",
    path: null,
    tags: null,
    pinned: true,
    createdAt: NOW,
    supersedes: null,
  });
  store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "newer-plain",
    path: null,
    tags: null,
    pinned: false,
    createdAt: NOW + 5,
    supersedes: null,
  });

  const notes = store.listNotes(10);
  assert.equal(notes.length, 2);
  assert.equal(notes[0]?.pinned, true);
  assert.equal(notes[0]?.body, "pinned-one");

  store.close();
});

test("notes: superseded notes are hidden, only the latest in a chain survives", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);

  const a = store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "v1",
    path: null,
    tags: null,
    pinned: false,
    createdAt: NOW,
    supersedes: null,
  });
  const b = store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "v2",
    path: null,
    tags: null,
    pinned: false,
    createdAt: NOW + 1,
    supersedes: a,
  });
  const c = store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "v3",
    path: null,
    tags: null,
    pinned: false,
    createdAt: NOW + 2,
    supersedes: b,
  });
  store.addNote({
    sessionId: "s1",
    harness: "opencode",
    body: "unrelated",
    path: null,
    tags: null,
    pinned: false,
    createdAt: NOW + 3,
    supersedes: null,
  });

  const notes = store.listNotes(10);
  assert.deepEqual(notes.map((n) => n.body).sort(), ["unrelated", "v3"]);

  // History stays addressable directly even though it's hidden from listings.
  assert.equal(store.getNote(a)?.body, "v1");
  assert.equal(store.getNote(c)?.supersedes, b);
  assert.equal(store.getNote(99_999), undefined);

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

test("advisories: record, refresh, prune by age", async () => {
  const store = await openStore(tmpDb());
  const day = 24 * 60 * 60 * 1000;

  assert.equal(store.getAdvisory("s1", "fp"), undefined);
  store.recordAdvisory("s1", "fp", NOW);
  assert.equal(store.getAdvisory("s1", "fp"), NOW);
  store.recordAdvisory("s1", "fp", NOW + 5); // upsert refreshes the timestamp
  assert.equal(store.getAdvisory("s1", "fp"), NOW + 5);

  store.recordAdvisory("s1", "old-picture", NOW - 2 * day);
  store.pruneAdvisories({ maxAgeDays: 1, now: NOW + 5 });
  assert.equal(store.getAdvisory("s1", "old-picture"), undefined);
  assert.equal(store.getAdvisory("s1", "fp"), NOW + 5);

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
