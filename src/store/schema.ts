/** DDL + migrations. Idempotent: safe to run on every `openStore`. */

import type { Db } from "./db.ts";

export const SCHEMA_VERSION = 6;

export interface SchemaInspection {
  tables: ReadonlySet<string>;
  version: number | undefined;
}

function compatibilityError(message: string): Error {
  return new Error(`incompatible Weaver store schema: ${message}`);
}

function parseSchemaVersion(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw compatibilityError("schema_version must be a nonnegative integer");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw compatibilityError("schema_version must be a safe nonnegative integer");
  }
  if (version > SCHEMA_VERSION) {
    throw compatibilityError(
      `schema version ${version} is newer than this Weaver supports (${SCHEMA_VERSION}); upgrade Weaver before opening it`,
    );
  }
  return version;
}

/** Read-only compatibility gate. This must run before any DDL or persistent PRAGMA. */
export function inspectSchemaCompatibility(db: Db): SchemaInspection {
  const rows = db.all<{ name: string; type: string }>("SELECT name, type FROM sqlite_master");
  const tables = new Set(rows.filter((row) => row.type === "table").map((row) => row.name));
  const existingTables = [...tables].filter((name) => !name.startsWith("sqlite_")).sort();
  const meta = rows.find((row) => row.name === "weaver_meta");
  if (!meta) {
    if (existingTables.length > 0) {
      throw compatibilityError(`schema_version is missing for existing tables: ${existingTables.join(", ")}`);
    }
    return { tables, version: undefined };
  }
  if (meta.type !== "table") throw compatibilityError("weaver_meta is not a table");

  let row: { value: unknown } | undefined;
  try {
    row = db.get<{ value: unknown }>("SELECT value FROM weaver_meta WHERE key = ?", "schema_version");
  } catch {
    throw compatibilityError("weaver_meta cannot be read");
  }
  if (!row && existingTables.length > 0) {
    throw compatibilityError(`schema_version is missing for existing tables: ${existingTables.join(", ")}`);
  }
  return { tables, version: row ? parseSchemaVersion(row.value) : undefined };
}

export function hasEarlyV6DashboardLeaseSchema(db: Db): boolean {
  const columns = db.all<{ name: string }>("PRAGMA table_info(dashboard_leases)");
  return columns.length > 0 && !columns.some((column) => column.name === "scope_id");
}

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  harness     TEXT NOT NULL,
  id_source   TEXT NOT NULL,
  pid         INTEGER,
  cwd         TEXT,
  worktree_id TEXT,
  intent      TEXT,
  started_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  pattern     TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released_at INTEGER
  ,worktree_id TEXT
  ,scratchpad_id INTEGER REFERENCES scratchpads(id)
);

CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT REFERENCES sessions(id),
  harness       TEXT,
  body          TEXT NOT NULL,
  path          TEXT,
  tags          TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  supersedes    INTEGER REFERENCES notes(id),
  retired_at    INTEGER,
  retired_by    TEXT,
  retire_reason TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  target      TEXT,
  summary     TEXT,
  meta        TEXT
  ,worktree_id TEXT
  ,scratchpad_id INTEGER REFERENCES scratchpads(id)
);

CREATE TABLE IF NOT EXISTS scratchpads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active', 'archived', 'trash')),
  previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('active', 'archived', 'trash')),
  revision       INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scratchpad_revisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scratchpad_id  INTEGER NOT NULL REFERENCES scratchpads(id),
  revision       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  state          TEXT NOT NULL,
  previous_state TEXT,
  created_at     INTEGER NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT,
  actor_harness  TEXT,
  worktree_id    TEXT,
  provenance     TEXT NOT NULL,
  action         TEXT NOT NULL,
  reason         TEXT,
  UNIQUE (scratchpad_id, revision)
);

CREATE TABLE IF NOT EXISTS scratchpad_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scratchpad_id INTEGER NOT NULL REFERENCES scratchpads(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  worktree_id   TEXT NOT NULL,
  attached_at   INTEGER NOT NULL,
  detached_at   INTEGER
);

-- Lightweight local protocol metrics. No raw args, paths, note bodies, or repo content.
CREATE TABLE IF NOT EXISTS command_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  command     TEXT NOT NULL,
  session_id  TEXT,
  harness     TEXT,
  id_source   TEXT
);

-- Pre-edit advisory cooldown: when a session was last warned about a given conflict picture.
-- No FK to sessions: a session's first pre-edit hook can fire before any session row exists.
CREATE TABLE IF NOT EXISTS advisories (
  session_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (session_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS dashboard_leases (
  scope_id   TEXT PRIMARY KEY CHECK (scope_id <> ''),
  owner_id   TEXT NOT NULL CHECK (owner_id <> ''),
  owner_pid  INTEGER NOT NULL CHECK (owner_pid > 0),
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at)
);

CREATE TABLE IF NOT EXISTS weaver_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_live      ON sessions(ended_at, last_seen);
CREATE INDEX IF NOT EXISTS idx_claims_active      ON claims(released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_claims_session     ON claims(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_recent    ON activity(ts);
CREATE INDEX IF NOT EXISTS idx_activity_target    ON activity(target);
CREATE INDEX IF NOT EXISTS idx_command_events_recent ON command_events(ts);
CREATE INDEX IF NOT EXISTS idx_command_events_command ON command_events(command, ts);
CREATE INDEX IF NOT EXISTS idx_notes_surface      ON notes(pinned, created_at);
CREATE INDEX IF NOT EXISTS idx_scratchpads_surface ON scratchpads(state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_scratchpad_revisions ON scratchpad_revisions(scratchpad_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_scratchpad_attachments_pad ON scratchpad_attachments(scratchpad_id, detached_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scratchpad_attachment_live
  ON scratchpad_attachments(session_id, worktree_id) WHERE detached_at IS NULL;
`;

export function migrate(db: Db): void {
  // Recheck under the caller's migration transaction before the first schema write.
  const inspection = inspectSchemaCompatibility(db);
  const existingVersion = inspection.version;
  db.exec(DDL);
  const version = existingVersion ?? SCHEMA_VERSION; // fresh DDL is already current

  // v1 → v2: note retirement (`weaver forget`). ALTER is needed because CREATE TABLE
  // IF NOT EXISTS never alters an existing table.
  if (version < 2) {
    db.exec(`
      ALTER TABLE notes ADD COLUMN retired_at INTEGER;
      ALTER TABLE notes ADD COLUMN retired_by TEXT;
      ALTER TABLE notes ADD COLUMN retire_reason TEXT;
    `);
  }

  // v2 → v3: command_events table is created by the idempotent DDL above.
  // v3 → v4: worktree snapshots distinguish isolated checkouts without changing repo identity.
  if (version < 4) {
    const hasColumn = (table: string, column: string): boolean =>
      db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
    // A v1 store can be missing whole tables, which the current DDL creates before this step.
    // Check each resulting table so ALTER remains safe for that mixed historical shape.
    if (!hasColumn("sessions", "worktree_id")) db.exec("ALTER TABLE sessions ADD COLUMN worktree_id TEXT");
    if (!hasColumn("claims", "worktree_id")) db.exec("ALTER TABLE claims ADD COLUMN worktree_id TEXT");
    if (!hasColumn("activity", "worktree_id")) db.exec("ALTER TABLE activity ADD COLUMN worktree_id TEXT");
  }

  // v4 → v5: scratchpads are additive. Existing notes remain the durable facts table and
  // receive no data rewrite; claims/activity only gain nullable attribution.
  if (version < 5) {
    const hasColumn = (table: string, column: string): boolean =>
      db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((entry) => entry.name === column);
    if (!hasColumn("claims", "scratchpad_id"))
      db.exec("ALTER TABLE claims ADD COLUMN scratchpad_id INTEGER REFERENCES scratchpads(id)");
    if (!hasColumn("activity", "scratchpad_id"))
      db.exec("ALTER TABLE activity ADD COLUMN scratchpad_id INTEGER REFERENCES scratchpads(id)");
  }

  // v5 → v6: dashboard_leases is additive and created by the idempotent DDL above. Early,
  // unreleased v6 builds used a fixed id=1 row; discard that unscoped lease if encountered.
  if (hasEarlyV6DashboardLeaseSchema(db)) {
    db.exec(`
      DROP TABLE dashboard_leases;
      CREATE TABLE dashboard_leases (
        scope_id   TEXT PRIMARY KEY CHECK (scope_id <> ''),
        owner_id   TEXT NOT NULL CHECK (owner_id <> ''),
        owner_pid  INTEGER NOT NULL CHECK (owner_pid > 0),
        renewed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at)
      );
    `);
  }

  if (existingVersion === undefined || version < SCHEMA_VERSION) {
    db.run(
      "INSERT INTO weaver_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "schema_version",
      String(SCHEMA_VERSION),
    );
  }
}
