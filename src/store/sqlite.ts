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
  CommandEventInput,
  CommandEventRow,
  DashboardLeaseInput,
  DashboardLeaseRow,
  NoteInput,
  NoteRow,
  PruneOptions,
  ScratchpadAttachmentInput,
  ScratchpadAttachmentRow,
  ScratchpadCreateInput,
  ScratchpadRevisionInput,
  ScratchpadRevisionRow,
  ScratchpadRow,
  ScratchpadState,
  ScratchpadUpdateInput,
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
  worktree_id: string | null;
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
  worktree_id: string | null;
  scratchpad_id: number | null;
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
  worktree_id: string | null;
  scratchpad_id: number | null;
}
interface RawScratchpad {
  id: number;
  title: string;
  body: string;
  state: string;
  previous_state: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}
interface RawScratchpadRevision {
  id: number;
  scratchpad_id: number;
  revision: number;
  title: string;
  body: string;
  state: string;
  previous_state: string | null;
  created_at: number;
  actor_kind: string;
  actor_id: string | null;
  actor_harness: string | null;
  worktree_id: string | null;
  provenance: string;
  action: string;
  reason: string | null;
}
interface RawScratchpadAttachment {
  id: number;
  scratchpad_id: number;
  session_id: string;
  worktree_id: string;
  attached_at: number;
  detached_at: number | null;
}
interface RawCommandEvent {
  id: number;
  ts: number;
  command: string;
  session_id: string | null;
  harness: string | null;
  id_source: string | null;
}
interface RawDashboardLease {
  scope_id: string;
  owner_id: string;
  owner_pid: number;
  renewed_at: number;
  expires_at: number;
}

const toSession = (r: RawSession): SessionRow => ({
  id: r.id,
  harness: r.harness,
  idSource: r.id_source as SessionRow["idSource"],
  pid: r.pid,
  cwd: r.cwd,
  worktreeId: r.worktree_id,
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
  worktreeId: r.worktree_id,
  scratchpadId: r.scratchpad_id,
});
const toScratchpad = (r: RawScratchpad): ScratchpadRow => ({
  id: r.id,
  title: r.title,
  body: r.body,
  state: r.state as ScratchpadState,
  previousState: r.previous_state as ScratchpadState | null,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toScratchpadRevision = (r: RawScratchpadRevision): ScratchpadRevisionRow => ({
  id: r.id,
  scratchpadId: r.scratchpad_id,
  revision: r.revision,
  title: r.title,
  body: r.body,
  state: r.state as ScratchpadState,
  previousState: r.previous_state as ScratchpadState | null,
  createdAt: r.created_at,
  actorKind: r.actor_kind as ScratchpadRevisionRow["actorKind"],
  actorId: r.actor_id,
  actorHarness: r.actor_harness,
  worktreeId: r.worktree_id,
  provenance: r.provenance,
  action: r.action,
  reason: r.reason,
});
const toScratchpadAttachment = (r: RawScratchpadAttachment): ScratchpadAttachmentRow => ({
  id: r.id,
  scratchpadId: r.scratchpad_id,
  sessionId: r.session_id,
  worktreeId: r.worktree_id,
  attachedAt: r.attached_at,
  detachedAt: r.detached_at,
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
  worktreeId: r.worktree_id,
  scratchpadId: r.scratchpad_id,
});
const toCommandEvent = (r: RawCommandEvent): CommandEventRow => ({
  id: r.id,
  ts: r.ts,
  command: r.command,
  sessionId: r.session_id,
  harness: r.harness,
  idSource: r.id_source as CommandEventRow["idSource"],
});
const toDashboardLease = (r: RawDashboardLease): DashboardLeaseRow => ({
  scopeId: r.scope_id,
  ownerId: r.owner_id,
  ownerPid: r.owner_pid,
  renewedAt: r.renewed_at,
  expiresAt: r.expires_at,
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
    // Insert on first sight; on live re-entry refresh heartbeat + identity fields while keeping
    // started_at/intent. If an ended identity reappears, start a fresh episode so tty/ancestry
    // fallback IDs do not accumulate multi-day durations after `weaver done`.
    this.db.run(
      `INSERT INTO sessions (id, harness, id_source, pid, cwd, worktree_id, intent, started_at, last_seen, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
          harness = excluded.harness,
          id_source = excluded.id_source,
          pid = excluded.pid,
          cwd = excluded.cwd,
          worktree_id = CASE
            WHEN sessions.ended_at IS NULL AND sessions.worktree_id IS NOT excluded.worktree_id THEN NULL
            ELSE excluded.worktree_id
          END,
          intent = CASE WHEN sessions.ended_at IS NULL THEN sessions.intent ELSE NULL END,
          started_at = CASE WHEN sessions.ended_at IS NULL THEN sessions.started_at ELSE excluded.started_at END,
          last_seen = excluded.last_seen,
          ended_at = NULL`,
      input.id,
      input.harness,
      input.idSource,
      input.pid,
      input.cwd,
      input.worktreeId ?? null,
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

  listSessions(limit: number): SessionRow[] {
    return this.db
      .all<RawSession>("SELECT * FROM sessions ORDER BY started_at DESC, last_seen DESC LIMIT ?", limit)
      .map(toSession);
  }

  listActiveSessions(now: number, ttlMs: number): SessionRow[] {
    return this.db
      .all<RawSession>(
        "SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen >= ? ORDER BY started_at",
        now - ttlMs,
      )
      .map(toSession);
  }

  listOpenSessions(): SessionRow[] {
    return this.db
      .all<RawSession>("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY last_seen DESC, started_at DESC")
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
      `INSERT INTO claims (session_id, pattern, reason, created_at, expires_at, released_at, worktree_id, scratchpad_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      input.sessionId,
      input.pattern,
      input.reason,
      input.createdAt,
      input.expiresAt,
      input.worktreeId ?? null,
      input.scratchpadId ?? null,
    ).lastInsertRowid;
  }

  releaseClaim(sessionId: string, pattern: string, now: number): void;
  releaseClaim(sessionId: string, pattern: string, worktreeId: string | null | undefined, now: number): void;
  releaseClaim(
    sessionId: string,
    pattern: string,
    worktreeIdOrNow: string | number | null | undefined,
    maybeNow?: number,
  ): void {
    const worktreeId = maybeNow === undefined ? null : worktreeIdOrNow;
    const now = maybeNow ?? (worktreeIdOrNow as number);
    this.db.run(
      "UPDATE claims SET released_at = ? WHERE session_id = ? AND pattern = ? AND worktree_id IS ? AND released_at IS NULL",
      now,
      sessionId,
      pattern,
      typeof worktreeId === "string" ? worktreeId : null,
    );
  }

  releaseAllClaims(sessionId: string, now: number): void;
  releaseAllClaims(sessionId: string, worktreeId: string | null | undefined, now: number): void;
  releaseAllClaims(sessionId: string, worktreeIdOrNow: string | number | null | undefined, maybeNow?: number): void {
    const worktreeId = maybeNow === undefined ? undefined : worktreeIdOrNow;
    const now = maybeNow ?? (worktreeIdOrNow as number);
    if (worktreeId === undefined) {
      this.db.run("UPDATE claims SET released_at = ? WHERE session_id = ? AND released_at IS NULL", now, sessionId);
      return;
    }
    this.db.run(
      "UPDATE claims SET released_at = ? WHERE session_id = ? AND worktree_id IS ? AND released_at IS NULL",
      now,
      sessionId,
      typeof worktreeId === "string" ? worktreeId : null,
    );
  }

  listActiveClaims(now: number): ClaimRow[] {
    return this.db
      .all<RawClaim>("SELECT * FROM claims WHERE released_at IS NULL AND expires_at > ? ORDER BY created_at", now)
      .map(toClaim);
  }

  listClaims(limit: number): ClaimRow[] {
    return this.db.all<RawClaim>("SELECT * FROM claims ORDER BY created_at DESC, id DESC LIMIT ?", limit).map(toClaim);
  }

  listOpenClaims(): ClaimRow[] {
    return this.db.all<RawClaim>("SELECT * FROM claims WHERE released_at IS NULL ORDER BY created_at").map(toClaim);
  }

  pruneClaims(opts: ClaimPruneOptions): void {
    const cutoff = ageCutoff(opts.now, opts.maxAgeDays);
    this.db.run("DELETE FROM claims WHERE released_at IS NOT NULL AND released_at < ?", cutoff);
    this.db.run("DELETE FROM claims WHERE released_at IS NULL AND expires_at < ?", cutoff);
  }

  createScratchpad(input: ScratchpadCreateInput): ScratchpadRow {
    const id = this.db.run(
      `INSERT INTO scratchpads (title, body, state, previous_state, revision, created_at, updated_at)
       VALUES (?, ?, 'active', NULL, 1, ?, ?)`,
      input.title,
      input.body,
      input.createdAt,
      input.createdAt,
    ).lastInsertRowid;
    return this.getScratchpad(id)!;
  }

  getScratchpad(id: number): ScratchpadRow | undefined {
    const row = this.db.get<RawScratchpad>("SELECT * FROM scratchpads WHERE id = ?", id);
    return row ? toScratchpad(row) : undefined;
  }

  listScratchpads(states: ScratchpadState[] | null, limit: number): ScratchpadRow[] {
    if (!states?.length) {
      return this.db
        .all<RawScratchpad>("SELECT * FROM scratchpads ORDER BY updated_at DESC, id DESC LIMIT ?", limit)
        .map(toScratchpad);
    }
    const placeholders = states.map(() => "?").join(", ");
    return this.db
      .all<RawScratchpad>(
        `SELECT * FROM scratchpads WHERE state IN (${placeholders}) ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...states,
        limit,
      )
      .map(toScratchpad);
  }

  findScratchpads(query: string, states: ScratchpadState[] | null, limit: number): ScratchpadRow[] {
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const stateSql = states?.length ? ` AND state IN (${states.map(() => "?").join(", ")})` : "";
    return this.db
      .all<RawScratchpad>(
        `SELECT * FROM scratchpads
         WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')${stateSql}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        pattern,
        pattern,
        ...(states ?? []),
        limit,
      )
      .map(toScratchpad);
  }

  updateScratchpad(input: ScratchpadUpdateInput): boolean {
    return (
      this.db.run(
        `UPDATE scratchpads
         SET title = ?, body = ?, state = ?, previous_state = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        input.title,
        input.body,
        input.state,
        input.previousState,
        input.updatedAt,
        input.id,
        input.expectedRevision,
      ).changes === 1
    );
  }

  addScratchpadRevision(input: ScratchpadRevisionInput): number {
    return this.db.run(
      `INSERT INTO scratchpad_revisions
       (scratchpad_id, revision, title, body, state, previous_state, created_at,
        actor_kind, actor_id, actor_harness, worktree_id, provenance, action, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.scratchpadId,
      input.revision,
      input.title,
      input.body,
      input.state,
      input.previousState,
      input.createdAt,
      input.actorKind,
      input.actorId,
      input.actorHarness,
      input.worktreeId,
      input.provenance,
      input.action,
      input.reason,
    ).lastInsertRowid;
  }

  listScratchpadRevisions(scratchpadId: number, limit: number): ScratchpadRevisionRow[] {
    return this.db
      .all<RawScratchpadRevision>(
        "SELECT * FROM scratchpad_revisions WHERE scratchpad_id = ? ORDER BY revision DESC LIMIT ?",
        scratchpadId,
        limit,
      )
      .map(toScratchpadRevision);
  }

  getScratchpadAttachment(sessionId: string, worktreeId: string): ScratchpadAttachmentRow | undefined {
    const row = this.db.get<RawScratchpadAttachment>(
      `SELECT * FROM scratchpad_attachments
       WHERE session_id = ? AND worktree_id = ? AND detached_at IS NULL`,
      sessionId,
      worktreeId,
    );
    return row ? toScratchpadAttachment(row) : undefined;
  }

  listScratchpadAttachments(scratchpadId?: number): ScratchpadAttachmentRow[] {
    const rows =
      scratchpadId === undefined
        ? this.db.all<RawScratchpadAttachment>(
            "SELECT * FROM scratchpad_attachments WHERE detached_at IS NULL ORDER BY attached_at, id",
          )
        : this.db.all<RawScratchpadAttachment>(
            `SELECT * FROM scratchpad_attachments
             WHERE scratchpad_id = ? AND detached_at IS NULL ORDER BY attached_at, id`,
            scratchpadId,
          );
    return rows.map(toScratchpadAttachment);
  }

  attachScratchpad(input: ScratchpadAttachmentInput): number {
    return this.db.run(
      `INSERT INTO scratchpad_attachments (scratchpad_id, session_id, worktree_id, attached_at, detached_at)
       VALUES (?, ?, ?, ?, NULL)`,
      input.scratchpadId,
      input.sessionId,
      input.worktreeId,
      input.attachedAt,
    ).lastInsertRowid;
  }

  detachScratchpad(sessionId: string, worktreeId: string, now: number): void {
    this.db.run(
      `UPDATE scratchpad_attachments SET detached_at = ?
       WHERE session_id = ? AND worktree_id = ? AND detached_at IS NULL`,
      now,
      sessionId,
      worktreeId,
    );
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
      `INSERT INTO activity (session_id, ts, kind, target, summary, meta, worktree_id, scratchpad_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.ts,
      input.kind,
      input.target,
      input.summary,
      input.meta,
      input.worktreeId ?? null,
      input.scratchpadId ?? null,
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

  addCommandEvent(input: CommandEventInput): number {
    return this.db.run(
      `INSERT INTO command_events (ts, command, session_id, harness, id_source)
       VALUES (?, ?, ?, ?, ?)`,
      input.ts,
      input.command,
      input.sessionId,
      input.harness,
      input.idSource,
    ).lastInsertRowid;
  }

  listRecentCommandEvents(limit: number): CommandEventRow[] {
    return this.db
      .all<RawCommandEvent>("SELECT * FROM command_events ORDER BY ts DESC, id DESC LIMIT ?", limit)
      .map(toCommandEvent);
  }

  pruneCommandEvents(opts: PruneOptions): void {
    this.db.run("DELETE FROM command_events WHERE ts < ?", ageCutoff(opts.now, opts.maxAgeDays));
    this.db.run(
      `DELETE FROM command_events WHERE id NOT IN (
         SELECT id FROM command_events ORDER BY ts DESC, id DESC LIMIT ?
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

  getDashboardLease(scopeId: string): DashboardLeaseRow | undefined {
    const row = this.db.get<RawDashboardLease>(
      "SELECT scope_id, owner_id, owner_pid, renewed_at, expires_at FROM dashboard_leases WHERE scope_id = ?",
      scopeId,
    );
    return row ? toDashboardLease(row) : undefined;
  }

  tryAcquireDashboardLease(input: DashboardLeaseInput): boolean {
    return (
      this.db.run(
        `INSERT INTO dashboard_leases (scope_id, owner_id, owner_pid, renewed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           owner_pid = excluded.owner_pid,
           renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at
          WHERE dashboard_leases.expires_at <= excluded.renewed_at`,
        input.scopeId,
        input.ownerId,
        input.ownerPid,
        input.renewedAt,
        input.expiresAt,
      ).changes === 1
    );
  }

  renewDashboardLease(input: DashboardLeaseInput): boolean {
    return (
      this.db.run(
        `UPDATE dashboard_leases SET owner_pid = ?, renewed_at = ?, expires_at = ?
         WHERE scope_id = ? AND owner_id = ? AND expires_at > ? AND renewed_at <= ?`,
        input.ownerPid,
        input.renewedAt,
        input.expiresAt,
        input.scopeId,
        input.ownerId,
        input.renewedAt,
        input.renewedAt,
      ).changes === 1
    );
  }

  releaseDashboardLease(scopeId: string, ownerId: string): boolean {
    return (
      this.db.run("DELETE FROM dashboard_leases WHERE scope_id = ? AND owner_id = ?", scopeId, ownerId).changes === 1
    );
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
