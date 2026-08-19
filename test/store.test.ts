import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configureWritableDb, openDb, withBusyRetry } from "../src/store/db.ts";
import { ensureWeaverDir, hardenDefaultStore } from "../src/store/location.ts";
import { openStore } from "../src/store/open.ts";
import { SCHEMA_VERSION } from "../src/store/schema.ts";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-test-"));
  return path.join(dir, "store.db");
}

const NOW = 1_000_000;
const TTL = 5 * 60 * 1000;

interface DatabaseSnapshot {
  bytes: Buffer;
  schema: Array<{ name: string; sql: string | null; type: string }>;
  sentinel: Array<{ value: string }>;
  persistentSidecars: { journal: Buffer | null; walFrames: Buffer | null };
}

async function snapshotDatabase(dbPath: string): Promise<DatabaseSnapshot> {
  const db = await openDb(dbPath, { readOnly: true, immutable: true });
  try {
    const walPath = `${dbPath}-wal`;
    const journalPath = `${dbPath}-journal`;
    return {
      bytes: fs.readFileSync(dbPath),
      schema: db.all<{ name: string; sql: string | null; type: string }>(
        "SELECT name, sql, type FROM sqlite_master ORDER BY type, name",
      ),
      sentinel: db.all<{ value: string }>("SELECT value FROM sentinel ORDER BY value"),
      persistentSidecars: {
        journal: fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : null,
        walFrames: fs.existsSync(walPath) && fs.statSync(walPath).size > 0 ? fs.readFileSync(walPath) : null,
      },
    };
  } finally {
    db.close();
  }
}

async function rejectedSchemaFixture(version: string): Promise<string> {
  const dbPath = tmpDb();
  const db = await openDb(dbPath);
  try {
    db.exec(`
      CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel (value TEXT NOT NULL);
    `);
    db.run("INSERT INTO weaver_meta (key, value) VALUES (?, ?)", "schema_version", version);
    db.run("INSERT INTO sentinel (value) VALUES (?)", "preserve me");
    configureWritableDb(db);
  } finally {
    db.close();
  }
  return dbPath;
}

test("busy retry is bounded, selective, and has no wait on the normal path", () => {
  const waits: number[] = [];
  let attempts = 0;
  const result = withBusyRetry(
    () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return "ok";
    },
    { delaysMs: [2, 4, 8], wait: (milliseconds) => waits.push(milliseconds) },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2, 4]);

  waits.length = 0;
  assert.equal(
    withBusyRetry(() => 7, { delaysMs: [2], wait: (milliseconds) => waits.push(milliseconds) }),
    7,
  );
  assert.deepEqual(waits, []);

  let persistentAttempts = 0;
  assert.throws(() => {
    withBusyRetry(
      () => {
        persistentAttempts++;
        throw new Error("database is locked");
      },
      { delaysMs: [1, 2], wait: () => undefined },
    );
  }, /database is locked/);
  assert.equal(persistentAttempts, 3);
  assert.throws(
    () => withBusyRetry(() => assert.fail("not a lock"), { delaysMs: [1], wait: () => undefined }),
    /not a lock/,
  );
});

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

test("opening an empty schema-less database initializes it, ignoring SQLite internal tables", async () => {
  for (const leaveSqliteSequence of [false, true]) {
    const dbPath = tmpDb();
    const raw = await openDb(dbPath);
    if (leaveSqliteSequence) {
      raw.exec("CREATE TABLE bootstrap_probe (id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE bootstrap_probe;");
      assert.deepEqual(
        raw.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name),
        ["sqlite_sequence"],
      );
    } else {
      assert.deepEqual(raw.all("SELECT name FROM sqlite_master WHERE type = 'table'"), []);
    }
    raw.close();

    const store = await openStore(dbPath);
    assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
    store.close();
  }
});

test("opening a populated unversioned database rejects before DDL and leaves it unchanged", async () => {
  const dbPath = tmpDb();
  const raw = await openDb(dbPath);
  raw.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('preserve me');");
  raw.close();
  const before = await snapshotDatabase(dbPath);

  await assert.rejects(() => openStore(dbPath), /schema_version is missing for existing tables: sentinel/);

  assert.deepEqual(await snapshotDatabase(dbPath), before);
});

test("opening a future schema rejects before DDL and leaves the database unchanged", async () => {
  const dbPath = await rejectedSchemaFixture(String(SCHEMA_VERSION + 1));
  const before = await snapshotDatabase(dbPath);

  await assert.rejects(() => openStore(dbPath), /schema version .* newer.*upgrade Weaver/);

  assert.deepEqual(await snapshotDatabase(dbPath), before);
});

test("opening a live-WAL future schema rejects without changing the database", async () => {
  const dbPath = tmpDb();
  const writer = await openDb(dbPath);
  try {
    writer.exec(`
      CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel (value TEXT NOT NULL);
    `);
    configureWritableDb(writer);
    writer.transaction(() => {
      writer.run("INSERT INTO weaver_meta (key, value) VALUES (?, ?)", "schema_version", String(SCHEMA_VERSION + 1));
      writer.run("INSERT INTO sentinel (value) VALUES (?)", "preserve live WAL");
    });

    const walPath = `${dbPath}-wal`;
    const sidecarPaths = [walPath, `${dbPath}-shm`, `${dbPath}-journal`];
    assert.equal(fs.existsSync(walPath), true);
    assert.ok(fs.statSync(walPath).size > 0);

    const mainOnly = await openDb(dbPath, { readOnly: true, immutable: true });
    try {
      assert.deepEqual(mainOnly.all("SELECT value FROM weaver_meta WHERE key = 'schema_version'"), []);
      assert.deepEqual(mainOnly.all("SELECT value FROM sentinel"), []);
    } finally {
      mainOnly.close();
    }

    const before = {
      bytes: fs.readFileSync(dbPath),
      schema: writer.all<{ name: string; sql: string | null; type: string }>(
        "SELECT name, sql, type FROM sqlite_master ORDER BY type, name",
      ),
      sentinel: writer.all<{ value: string }>("SELECT value FROM sentinel ORDER BY value"),
      version: writer.get<{ value: string }>("SELECT value FROM weaver_meta WHERE key = 'schema_version'"),
      wal: fs.readFileSync(walPath),
      sidecars: sidecarPaths.map((filePath) => fs.existsSync(filePath)),
    };

    await assert.rejects(() => openStore(dbPath), /schema version .* newer.*upgrade Weaver/);

    assert.deepEqual(fs.readFileSync(dbPath), before.bytes);
    assert.deepEqual(
      writer.all<{ name: string; sql: string | null; type: string }>(
        "SELECT name, sql, type FROM sqlite_master ORDER BY type, name",
      ),
      before.schema,
    );
    assert.deepEqual(writer.all<{ value: string }>("SELECT value FROM sentinel ORDER BY value"), before.sentinel);
    assert.deepEqual(
      writer.get<{ value: string }>("SELECT value FROM weaver_meta WHERE key = 'schema_version'"),
      before.version,
    );
    assert.deepEqual(fs.readFileSync(walPath), before.wal);
    // SQLite's shared-memory lock bytes are runtime-managed, so only sidecar presence is portable.
    assert.deepEqual(
      sidecarPaths.map((filePath) => fs.existsSync(filePath)),
      before.sidecars,
    );
  } finally {
    writer.close();
  }
});

test("opening a stale-WAL future schema with no live writer rejects without a writable open", async () => {
  const dbPath = tmpDb();
  const writer = await openDb(dbPath);
  writer.exec(`
    CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sentinel (value TEXT NOT NULL);
  `);
  configureWritableDb(writer);
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.transaction(() => {
    writer.run("INSERT INTO weaver_meta (key, value) VALUES (?, ?)", "schema_version", String(SCHEMA_VERSION + 1));
    writer.run("INSERT INTO sentinel (value) VALUES (?)", "preserve stale WAL");
  });

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assert.equal(fs.existsSync(walPath), true);
  assert.equal(fs.existsSync(shmPath), true);
  const stale = {
    db: fs.readFileSync(dbPath),
    wal: fs.readFileSync(walPath),
    shm: fs.readFileSync(shmPath),
  };
  writer.close();

  // Closing the final writer normally checkpoints. Restore the coherent pre-close files to
  // model a writer that exited without cleanup, while leaving no process or SQLite lock alive.
  fs.writeFileSync(dbPath, stale.db);
  fs.writeFileSync(walPath, stale.wal);
  fs.writeFileSync(shmPath, stale.shm);

  const mainOnly = await openDb(dbPath, { readOnly: true, immutable: true });
  try {
    assert.deepEqual(mainOnly.all("SELECT value FROM weaver_meta WHERE key = 'schema_version'"), []);
    assert.deepEqual(mainOnly.all("SELECT value FROM sentinel"), []);
  } finally {
    mainOnly.close();
  }

  const lockAware = await openDb(dbPath, { readOnly: true });
  try {
    assert.equal(
      lockAware.get<{ value: string }>("SELECT value FROM weaver_meta WHERE key = 'schema_version'")?.value,
      String(SCHEMA_VERSION + 1),
    );
    assert.deepEqual(
      lockAware.all<{ value: string }>("SELECT value FROM sentinel").map((row) => row.value),
      ["preserve stale WAL"],
    );
  } finally {
    lockAware.close();
  }

  const before = { db: fs.readFileSync(dbPath), wal: fs.readFileSync(walPath) };
  await assert.rejects(() => openStore(dbPath), /schema version .* newer.*upgrade Weaver/);
  assert.deepEqual(fs.readFileSync(dbPath), before.db);
  assert.deepEqual(fs.readFileSync(walPath), before.wal);
  assert.equal(fs.existsSync(shmPath), true);
});

test("opening a malformed schema version rejects before DDL and leaves the database unchanged", async () => {
  const dbPath = await rejectedSchemaFixture(` ${SCHEMA_VERSION}`);
  const before = await snapshotDatabase(dbPath);

  await assert.rejects(() => openStore(dbPath), /schema_version must be a nonnegative integer/);

  assert.deepEqual(await snapshotDatabase(dbPath), before);
});

test("default store hardening follows canonical home aliases without changing explicit shared homes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-permissions-"));
  const defaultDir = path.join(root, ".weaver");
  fs.mkdirSync(defaultDir, { mode: 0o777 });
  const dbPath = path.join(defaultDir, "repo.db");
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.writeFileSync(file, "", { mode: 0o666 });
  const defaultAlias = path.join(root, "default-alias");
  fs.symlinkSync(defaultDir, defaultAlias, "dir");
  hardenDefaultStore(dbPath, undefined, defaultAlias);
  assert.equal(fs.statSync(defaultDir).mode & 0o777, 0o700);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.chmodSync(defaultDir, 0o775);
  fs.chmodSync(dbPath, 0o664);
  hardenDefaultStore(dbPath, defaultDir, defaultDir);
  assert.equal(fs.statSync(defaultDir).mode & 0o777, 0o775);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o664);
});

test("default store creation is private under a permissive umask while explicit shared homes are unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dir-permissions-"));
  const defaultDir = path.join(root, "default");
  const previousUmask = process.umask(0);
  try {
    ensureWeaverDir(undefined, defaultDir);
    assert.equal(fs.statSync(defaultDir).mode & 0o777, 0o700);
    const defaultDb = path.join(defaultDir, "repo.db");
    const privateStore = await openStore(defaultDb, {
      location: { explicitHome: undefined, defaultHome: defaultDir },
    });
    privateStore.setMeta("permission_probe", "1");
    assert.equal(fs.statSync(defaultDb).mode & 0o777, 0o600);
    for (const sidecar of [`${defaultDb}-wal`, `${defaultDb}-shm`]) {
      assert.equal(fs.existsSync(sidecar), true);
      assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
    }
    privateStore.close();

    const incompatible = await openDb(defaultDb);
    incompatible.run("UPDATE weaver_meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION + 1));
    incompatible.close();
    fs.chmodSync(defaultDb, 0o666);
    await assert.rejects(
      () =>
        openStore(defaultDb, {
          location: { explicitHome: undefined, defaultHome: defaultDir },
        }),
      /schema version .* newer.*upgrade Weaver/,
    );
    assert.equal(fs.statSync(defaultDb).mode & 0o777, 0o600);

    const sharedDir = path.join(root, "shared");
    fs.mkdirSync(sharedDir, { mode: 0o775 });
    fs.chmodSync(sharedDir, 0o775);
    ensureWeaverDir(sharedDir, defaultDir);
    const sharedDb = path.join(sharedDir, "repo.db");
    fs.writeFileSync(sharedDb, "", { mode: 0o664 });
    fs.chmodSync(sharedDb, 0o664);
    const sharedStore = await openStore(sharedDb, {
      location: { explicitHome: sharedDir, defaultHome: defaultDir },
    });
    sharedStore.setMeta("permission_probe", "1");
    assert.equal(fs.statSync(sharedDir).mode & 0o777, 0o775);
    assert.equal(fs.statSync(sharedDb).mode & 0o777, 0o664);
    sharedStore.close();
  } finally {
    process.umask(previousUmask);
  }
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
