/** DDL + migrations. Idempotent: safe to run on every `openStore`. */

import type { Db } from "./db.ts";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  harness     TEXT NOT NULL,
  id_source   TEXT NOT NULL,
  pid         INTEGER,
  cwd         TEXT,
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
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT REFERENCES sessions(id),
  harness     TEXT,
  body        TEXT NOT NULL,
  path        TEXT,
  tags        TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  supersedes  INTEGER REFERENCES notes(id)
);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  target      TEXT,
  summary     TEXT,
  meta        TEXT
);

-- Pre-edit advisory cooldown: when a session was last warned about a given conflict picture.
-- No FK to sessions: a session's first pre-edit hook can fire before any session row exists.
CREATE TABLE IF NOT EXISTS advisories (
  session_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (session_id, fingerprint)
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
CREATE INDEX IF NOT EXISTS idx_notes_surface      ON notes(pinned, created_at);
`;

export function migrate(db: Db): void {
  db.exec(DDL);
  const row = db.get<{ value: string }>("SELECT value FROM weaver_meta WHERE key = ?", "schema_version");
  if (!row) {
    db.run("INSERT INTO weaver_meta (key, value) VALUES (?, ?)", "schema_version", String(SCHEMA_VERSION));
  }
  // Future migrations key off the stored schema_version here.
}
