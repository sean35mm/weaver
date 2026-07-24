import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/store/db.ts";
import { openStore } from "../src/store/open.ts";
import { SCHEMA_VERSION } from "../src/store/schema.ts";

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

test("sessions: re-entering an ended identity starts a fresh episode", async () => {
  const store = await openStore(tmpDb());

  store.upsertSession({ id: "tty:ttys001@host", harness: "opencode", idSource: "ancestry", pid: null, cwd: null }, NOW);
  store.setIntent("tty:ttys001@host", "old work", NOW + 1);
  store.endSession("tty:ttys001@host", NOW + 2);
  store.upsertSession(
    { id: "tty:ttys001@host", harness: "opencode", idSource: "ancestry", pid: null, cwd: null },
    NOW + 100,
  );

  const session = store.getSession("tty:ttys001@host");
  assert.equal(session?.startedAt, NOW + 100);
  assert.equal(session?.lastSeen, NOW + 100);
  assert.equal(session?.endedAt, null);
  assert.equal(session?.intent, null);

  store.close();
});

test("sessions: live re-entry preserves started_at and intent", async () => {
  const store = await openStore(tmpDb());

  store.upsertSession({ id: "s1", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  store.setIntent("s1", "current work", NOW + 1);
  store.upsertSession({ id: "s1", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW + 100);

  const session = store.getSession("s1");
  assert.equal(session?.startedAt, NOW);
  assert.equal(session?.lastSeen, NOW + 100);
  assert.equal(session?.intent, "current work");

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

test("sessions: open sessions include stale unended rows", async () => {
  const store = await openStore(tmpDb());

  store.upsertSession({ id: "old", harness: "opencode", idSource: "ancestry", pid: null, cwd: null }, NOW - TTL - 1);
  store.upsertSession({ id: "live", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  store.upsertSession({ id: "done", harness: "claude-code", idSource: "harness", pid: null, cwd: null }, NOW);
  store.endSession("done", NOW + 1);

  assert.deepEqual(
    store.listOpenSessions().map((s) => s.id),
    ["live", "old"],
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

test("worktree snapshots preserve claims and mark a live identity as ambiguous across worktrees", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession(
    { id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-a" },
    NOW,
  );
  store.addClaim({
    sessionId: "s1",
    pattern: "src/auth/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + TTL,
    worktreeId: "wt-a",
  });
  store.addActivity({
    sessionId: "s1",
    ts: NOW,
    kind: "edit",
    target: "src/auth/login.ts",
    summary: null,
    meta: null,
    worktreeId: "wt-a",
  });
  assert.equal(store.getSession("s1")?.worktreeId, "wt-a");
  assert.equal(store.listOpenClaims()[0]?.worktreeId, "wt-a");
  assert.equal(store.listRecentActivity(1)[0]?.worktreeId, "wt-a");

  store.upsertSession(
    { id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-b" },
    NOW + 1,
  );
  assert.equal(store.getSession("s1")?.worktreeId, null);
  assert.equal(store.listOpenClaims().length, 1);
  assert.equal(store.listOpenClaims()[0]?.worktreeId, "wt-a");

  store.endSession("s1", NOW + 2);
  store.upsertSession(
    { id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-b" },
    NOW + 3,
  );
  assert.equal(store.getSession("s1")?.worktreeId, "wt-b");
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
  // the casts bypass the compile-time async ban on purpose: these exercise the runtime guard
  assert.throws(() => {
    store.transaction(() => Promise.resolve("later") as never);
  }, /async transactions/);
  assert.throws(() => {
    store.transaction((async () => {
      asyncInvoked = true;
      await Promise.resolve();
      store.upsertSession({ id: "late", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
    }) as unknown as () => never);
  }, /async transactions/);

  assert.equal(asyncInvoked, false);
  assert.equal(store.getSession("late"), undefined);
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

test("command events: insert, recent order, and prune", async () => {
  const store = await openStore(tmpDb());
  const day = 24 * 60 * 60 * 1000;

  store.addCommandEvent({
    ts: NOW,
    command: "status",
    sessionId: "explicit:agent@h",
    harness: "opencode",
    idSource: "explicit",
  });
  store.addCommandEvent({ ts: NOW + 1, command: "preflight", sessionId: null, harness: null, idSource: null });
  store.addCommandEvent({ ts: NOW - 3 * day, command: "old", sessionId: null, harness: null, idSource: null });

  const recent = store.listRecentCommandEvents(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0]?.command, "preflight");
  assert.equal(recent[1]?.sessionId, "explicit:agent@h");
  assert.equal(recent[1]?.harness, "opencode");
  assert.equal(recent[1]?.idSource, "explicit");

  store.pruneCommandEvents({ maxEvents: 1, maxAgeDays: 2, now: NOW + 2 });
  assert.deepEqual(
    store.listRecentCommandEvents(10).map((event) => event.command),
    ["preflight"],
  );

  store.close();
});

test("migration: a v1 store gains new tables/columns, keeps data, and stamps current version", async () => {
  const dbPath = tmpDb();
  const raw = await openDb(dbPath);
  raw.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, harness TEXT, body TEXT NOT NULL,
      path TEXT, tags TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      supersedes INTEGER
    );
    CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO weaver_meta (key, value) VALUES ('schema_version', '1');
    INSERT INTO notes (body, created_at, pinned) VALUES ('legacy learning', 123, 1);
  `);
  raw.close();

  const store = await openStore(dbPath); // migrates on open
  assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
  const notes = store.listNotes(10);
  assert.equal(notes[0]?.body, "legacy learning");
  assert.equal(notes[0]?.pinned, true);
  assert.equal(notes[0]?.retiredAt, null);

  store.retireNote(notes[0]!.id, "s1", "stale", 200);
  assert.equal(store.listNotes(10).length, 0);

  // reopening must not re-run the v1→current steps (duplicate ALTER would throw)
  store.close();
  const reopened = await openStore(dbPath);
  assert.equal(reopened.getMeta("schema_version"), String(SCHEMA_VERSION));
  reopened.close();
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
