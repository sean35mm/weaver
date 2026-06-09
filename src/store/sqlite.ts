/** SQLite-backed implementation of the `Store` interface. */

import type { Db } from "./db.ts";
import { ageCutoff } from "./reap.ts";
import type {
  ActivityInput,
  ActivityRow,
  AgePruneOptions,
  ClaimInput,
  ClaimPruneOptions,
  ClaimRow,
  NoteInput,
  NoteRow,
  PruneOptions,
  SessionInput,
  SessionRow,
  Store,
  SyncTransactionResult,
} from "./store.ts";

interface RawSession {
  id: string;
  harness: string;
  id_source: string;
  pid: number | null;
  cwd: string | null;
  intent: string | null;
  started_at: number;
  last_seen: number;
  ended_at: number | null;
}
interface RawClaim {
  id: number;
  session_id: string;
  pattern: string;
  reason: string | null;
  created_at: number;
  expires_at: number;
  released_at: number | null;
}
interface RawNote {
  id: number;
  session_id: string | null;
  harness: string | null;
  body: string;
  path: string | null;
  tags: string | null;
  pinned: number;
  created_at: number;
  supersedes: number | null;
  retired_at: number | null;
  retired_by: string | null;
  retire_reason: string | null;
  superseded_by?: number | null;
}
interface RawActivity {
  id: number;
  session_id: string;
  ts: number;
  kind: string;
  target: string | null;
  summary: string | null;
  meta: string | null;
}

const toSession = (r: RawSession): SessionRow => ({
  id: r.id,
  harness: r.harness,
  idSource: r.id_source as SessionRow["idSource"],
  pid: r.pid,
  cwd: r.cwd,
  intent: r.intent,
  startedAt: r.started_at,
  lastSeen: r.last_seen,
  endedAt: r.ended_at,
});
const toClaim = (r: RawClaim): ClaimRow => ({
  id: r.id,
  sessionId: r.session_id,
  pattern: r.pattern,
  reason: r.reason,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  releasedAt: r.released_at,
});
const toNote = (r: RawNote): NoteRow => ({
  id: r.id,
  sessionId: r.session_id,
  harness: r.harness,
  body: r.body,
  path: r.path,
  tags: r.tags,
  pinned: r.pinned !== 0,
  createdAt: r.created_at,
  supersedes: r.supersedes,
  retiredAt: r.retired_at,
  retiredBy: r.retired_by,
  retireReason: r.retire_reason,
  ...(r.superseded_by !== undefined ? { superseded: r.superseded_by !== null } : {}),
});
const toActivity = (r: RawActivity): ActivityRow => ({
  id: r.id,
  sessionId: r.session_id,
  ts: r.ts,
  kind: r.kind as ActivityRow["kind"],
  target: r.target,
  summary: r.summary,
  meta: r.meta,
});

export class SqliteStore implements Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  transaction<T>(fn: () => SyncTransactionResult<T>): SyncTransactionResult<T> {
    return this.db.transaction(fn);
  }

  upsertSession(input: SessionInput, now: number): void {
    // Insert on first sight; on re-entry refresh heartbeat + identity fields but keep
    // started_at/intent and clear any prior ended_at (the session is live again).
    this.db.run(
      `INSERT INTO sessions (id, harness, id_source, pid, cwd, intent, started_at, last_seen, ended_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         harness = excluded.harness,
         id_source = excluded.id_source,
         pid = excluded.pid,
         cwd = excluded.cwd,
         last_seen = excluded.last_seen,
         ended_at = NULL`,
      input.id,
      input.harness,
      input.idSource,
      input.pid,
      input.cwd,
      now,
      now,
    );
  }

  touchSession(id: string, now: number): void {
    this.db.run("UPDATE sessions SET last_seen = ?, ended_at = NULL WHERE id = ?", now, id);
  }

  setIntent(id: string, intent: string, now: number): void {
    this.db.run("UPDATE sessions SET intent = ?, last_seen = ? WHERE id = ?", intent, now, id);
  }

  endSession(id: string, now: number): void {
    this.db.run("UPDATE sessions SET ended_at = ?, last_seen = ? WHERE id = ?", now, now, id);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.get<RawSession>("SELECT * FROM sessions WHERE id = ?", id);
    return r ? toSession(r) : undefined;
  }

  listActiveSessions(now: number, ttlMs: number): SessionRow[] {
    return this.db
      .all<RawSession>(
        "SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen >= ? ORDER BY started_at",
        now - ttlMs,
      )
      .map(toSession);
  }

  listRecentEndedSessions(limit: number, since?: number): SessionRow[] {
    if (since !== undefined) {
      return this.db
        .all<RawSession>(
          "SELECT * FROM sessions WHERE ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC, started_at DESC LIMIT ?",
          since,
          limit,
        )
        .map(toSession);
    }
    return this.db
      .all<RawSession>(
        "SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, started_at DESC LIMIT ?",
        limit,
      )
      .map(toSession);
  }

  addClaim(input: ClaimInput): number {
    return this.db.run(
      `INSERT INTO claims (session_id, pattern, reason, created_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      input.sessionId,
      input.pattern,
      input.reason,
      input.createdAt,
      input.expiresAt,
    ).lastInsertRowid;
  }

  releaseClaim(sessionId: string, pattern: string, now: number): void {
    this.db.run(
      "UPDATE claims SET released_at = ? WHERE session_id = ? AND pattern = ? AND released_at IS NULL",
      now,
      sessionId,
      pattern,
    );
  }

  releaseAllClaims(sessionId: string, now: number): void {
    this.db.run("UPDATE claims SET released_at = ? WHERE session_id = ? AND released_at IS NULL", now, sessionId);
  }

  listActiveClaims(now: number): ClaimRow[] {
    return this.db
      .all<RawClaim>("SELECT * FROM claims WHERE released_at IS NULL AND expires_at > ? ORDER BY created_at", now)
      .map(toClaim);
  }

  listOpenClaims(): ClaimRow[] {
    return this.db.all<RawClaim>("SELECT * FROM claims WHERE released_at IS NULL ORDER BY created_at").map(toClaim);
  }

  pruneClaims(opts: ClaimPruneOptions): void {
    const cutoff = ageCutoff(opts.now, opts.maxAgeDays);
    this.db.run("DELETE FROM claims WHERE released_at IS NOT NULL AND released_at < ?", cutoff);
    this.db.run("DELETE FROM claims WHERE released_at IS NULL AND expires_at < ?", cutoff);
  }

  addNote(input: NoteInput): number {
    return this.db.run(
      `INSERT INTO notes (session_id, harness, body, path, tags, pinned, created_at, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.harness,
      input.body,
      input.path,
      input.tags,
      input.pinned ? 1 : 0,
      input.createdAt,
      input.supersedes,
    ).lastInsertRowid;
  }

  getNote(id: number): NoteRow | undefined {
    const r = this.db.get<RawNote>("SELECT * FROM notes WHERE id = ?", id);
    return r ? toNote(r) : undefined;
  }

  listNotes(limit: number): NoteRow[] {
    // Superseded and retired notes are history, not the current picture.
    return this.db
      .all<RawNote>(
        `SELECT * FROM notes
         WHERE retired_at IS NULL
           AND id NOT IN (SELECT supersedes FROM notes WHERE supersedes IS NOT NULL)
         ORDER BY pinned DESC, created_at DESC LIMIT ?`,
        limit,
      )
      .map(toNote);
  }

  listAllNotes(limit: number): NoteRow[] {
    return this.db
      .all<RawNote>(
        `SELECT n.*, (SELECT s.id FROM notes s WHERE s.supersedes = n.id LIMIT 1) AS superseded_by
         FROM notes n ORDER BY n.created_at DESC LIMIT ?`,
        limit,
      )
      .map(toNote);
  }

  retireNote(id: number, retiredBy: string, reason: string, now: number): void {
    this.db.run(
      "UPDATE notes SET retired_at = ?, retired_by = ?, retire_reason = ? WHERE id = ?",
      now,
      retiredBy,
      reason,
      id,
    );
  }

  restoreNote(id: number): void {
    this.db.run("UPDATE notes SET retired_at = NULL, retired_by = NULL, retire_reason = NULL WHERE id = ?", id);
  }

  addActivity(input: ActivityInput): number {
    return this.db.run(
      `INSERT INTO activity (session_id, ts, kind, target, summary, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.ts,
      input.kind,
      input.target,
      input.summary,
      input.meta,
    ).lastInsertRowid;
  }

  listRecentActivity(limit: number): ActivityRow[] {
    return this.db.all<RawActivity>("SELECT * FROM activity ORDER BY ts DESC, id DESC LIMIT ?", limit).map(toActivity);
  }

  pruneActivity(opts: PruneOptions): void {
    // Drop events older than the age cutoff, then trim to the newest `maxEvents`.
    this.db.run("DELETE FROM activity WHERE ts < ?", ageCutoff(opts.now, opts.maxAgeDays));
    this.db.run(
      `DELETE FROM activity WHERE id NOT IN (
         SELECT id FROM activity ORDER BY ts DESC, id DESC LIMIT ?
       )`,
      opts.maxEvents,
    );
  }

  getAdvisory(sessionId: string, fingerprint: string): number | undefined {
    return this.db.get<{ ts: number }>(
      "SELECT ts FROM advisories WHERE session_id = ? AND fingerprint = ?",
      sessionId,
      fingerprint,
    )?.ts;
  }

  recordAdvisory(sessionId: string, fingerprint: string, ts: number): void {
    this.db.run(
      `INSERT INTO advisories (session_id, fingerprint, ts) VALUES (?, ?, ?)
       ON CONFLICT(session_id, fingerprint) DO UPDATE SET ts = excluded.ts`,
      sessionId,
      fingerprint,
      ts,
    );
  }

  pruneAdvisories(opts: AgePruneOptions): void {
    this.db.run("DELETE FROM advisories WHERE ts < ?", ageCutoff(opts.now, opts.maxAgeDays));
  }

  getMeta(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM weaver_meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO weaver_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  close(): void {
    this.db.close();
  }
}
