/**
 * The persistence seam. Verbs depend on this interface, never on SQLite directly, so the
 * backend can evolve (e.g. a graph store) without touching command logic. All timestamps are
 * epoch milliseconds and are passed in by callers (an injected clock) for testability.
 */

export type IdSource = "explicit" | "harness" | "tty" | "ancestry";

/** Runtime list (TS types are erased) so the CLI can validate/normalize `kind`. */
export const ACTIVITY_KINDS = [
  "edit",
  "create",
  "delete",
  "run",
  "claim",
  "release",
  "task",
  "note",
  "forget",
  "join",
  "done",
  "scratchpad",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type SyncTransactionResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface SessionInput {
  id: string;
  harness: string;
  idSource: IdSource;
  pid: number | null;
  cwd: string | null;
  worktreeId?: string | null;
}

export interface SessionRow extends SessionInput {
  intent: string | null;
  startedAt: number;
  lastSeen: number;
  endedAt: number | null;
}

export interface ClaimInput {
  sessionId: string;
  pattern: string;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  /** Immutable checkout snapshot; null preserves conservative legacy behavior. */
  worktreeId?: string | null;
  /** Scratchpad active for this session/worktree when the claim was recorded. */
  scratchpadId?: number | null;
}

export interface ClaimRow extends ClaimInput {
  id: number;
  releasedAt: number | null;
}

export interface NoteInput {
  sessionId: string | null;
  harness: string | null;
  body: string;
  path: string | null;
  tags: string | null;
  pinned: boolean;
  createdAt: number;
  supersedes: number | null;
}

export interface NoteRow extends NoteInput {
  id: number;
  retiredAt: number | null;
  retiredBy: string | null;
  retireReason: string | null;
  /** True when another note supersedes this one (computed; only populated by `listAllNotes`). */
  superseded?: boolean;
}

export interface ActivityInput {
  sessionId: string;
  ts: number;
  kind: ActivityKind;
  target: string | null;
  summary: string | null;
  meta: string | null;
  /** Immutable checkout snapshot; null preserves conservative legacy behavior. */
  worktreeId?: string | null;
  /** Scratchpad active for this session/worktree when the event was recorded. */
  scratchpadId?: number | null;
}

export interface ActivityRow extends ActivityInput {
  id: number;
}

export interface CommandEventInput {
  ts: number;
  command: string;
  sessionId: string | null;
  harness: string | null;
  idSource: IdSource | null;
}

export interface CommandEventRow extends CommandEventInput {
  id: number;
}

export interface PruneOptions {
  maxEvents: number;
  maxAgeDays: number;
  now: number;
}

export interface AgePruneOptions {
  maxAgeDays: number;
  now: number;
}

export type ClaimPruneOptions = AgePruneOptions;

export const SCRATCHPAD_STATES = ["active", "archived", "trash"] as const;
export type ScratchpadState = (typeof SCRATCHPAD_STATES)[number];
export type ScratchpadActorKind = "agent" | "human" | "system";

export interface ScratchpadCreateInput {
  title: string;
  body: string;
  createdAt: number;
}

export interface ScratchpadRow {
  id: number;
  title: string;
  body: string;
  state: ScratchpadState;
  previousState: ScratchpadState | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadUpdateInput {
  id: number;
  expectedRevision: number;
  title: string;
  body: string;
  state: ScratchpadState;
  previousState: ScratchpadState | null;
  updatedAt: number;
}

export interface ScratchpadRevisionInput {
  scratchpadId: number;
  revision: number;
  title: string;
  body: string;
  state: ScratchpadState;
  previousState: ScratchpadState | null;
  createdAt: number;
  actorKind: ScratchpadActorKind;
  actorId: string | null;
  actorHarness: string | null;
  /** Physical checkout where the revision originated, when one was resolved. */
  worktreeId: string | null;
  provenance: string;
  action: string;
  reason: string | null;
}

export interface ScratchpadRevisionRow extends ScratchpadRevisionInput {
  id: number;
}

export interface ScratchpadAttachmentInput {
  scratchpadId: number;
  sessionId: string;
  worktreeId: string;
  attachedAt: number;
}

export interface ScratchpadAttachmentRow extends ScratchpadAttachmentInput {
  id: number;
  detachedAt: number | null;
}

export interface Store {
  /** Execute related writes atomically. Transactions are synchronous and non-nested. */
  transaction<T>(fn: () => SyncTransactionResult<T>): SyncTransactionResult<T>;

  // sessions — presence registration happens only for agent/mutating commands
  upsertSession(input: SessionInput, now: number): void;
  touchSession(id: string, now: number): void;
  setIntent(id: string, intent: string, now: number): void;
  endSession(id: string, now: number): void;
  getSession(id: string): SessionRow | undefined;
  listSessions(limit: number): SessionRow[];
  /** Live = not ended and seen within `ttlMs`. */
  listActiveSessions(now: number, ttlMs: number): SessionRow[];
  /** Not explicitly ended, including stale sessions. */
  listOpenSessions(): SessionRow[];
  listRecentEndedSessions(limit: number, since?: number): SessionRow[];

  // claims (advisory, TTL'd, co-claims allowed)
  addClaim(input: ClaimInput): number;
  releaseClaim(sessionId: string, pattern: string, now: number): void;
  releaseClaim(sessionId: string, pattern: string, worktreeId: string | null | undefined, now: number): void;
  releaseAllClaims(sessionId: string, now: number): void;
  releaseAllClaims(sessionId: string, worktreeId: string | null | undefined, now: number): void;
  /** Not released and not expired at `now`. */
  listActiveClaims(now: number): ClaimRow[];
  listClaims(limit: number): ClaimRow[];
  /** Not released, regardless of expiry — used by conflict detection to surface stale holds. */
  listOpenClaims(): ClaimRow[];
  pruneClaims(opts: ClaimPruneOptions): void;

  // scratchpads (canonical Markdown + append-only snapshots)
  createScratchpad(input: ScratchpadCreateInput): ScratchpadRow;
  getScratchpad(id: number): ScratchpadRow | undefined;
  listScratchpads(states: ScratchpadState[] | null, limit: number): ScratchpadRow[];
  findScratchpads(query: string, states: ScratchpadState[] | null, limit: number): ScratchpadRow[];
  /** Conditional current-row update; callers append the matching revision in the same transaction. */
  updateScratchpad(input: ScratchpadUpdateInput): boolean;
  addScratchpadRevision(input: ScratchpadRevisionInput): number;
  listScratchpadRevisions(scratchpadId: number, limit: number): ScratchpadRevisionRow[];

  // scratchpad attachments (at most one live pad per session + physical checkout)
  getScratchpadAttachment(sessionId: string, worktreeId: string): ScratchpadAttachmentRow | undefined;
  listScratchpadAttachments(scratchpadId?: number): ScratchpadAttachmentRow[];
  attachScratchpad(input: ScratchpadAttachmentInput): number;
  detachScratchpad(sessionId: string, worktreeId: string, now: number): void;

  // notes (durable, repo-scoped; removal is always soft — retire, never delete)
  addNote(input: NoteInput): number;
  getNote(id: number): NoteRow | undefined;
  /** Excludes superseded and retired notes — only the current picture is listed. */
  listNotes(limit: number): NoteRow[];
  /** Everything, newest first, with `superseded` computed — the curation history view. */
  listAllNotes(limit: number): NoteRow[];
  retireNote(id: number, retiredBy: string, reason: string, now: number): void;
  restoreNote(id: number): void;

  // activity (time-ordered; pruned lazily)
  addActivity(input: ActivityInput): number;
  listRecentActivity(limit: number): ActivityRow[];
  pruneActivity(opts: PruneOptions): void;

  // command usage (privacy-safe protocol metrics; no args/paths/content)
  addCommandEvent(input: CommandEventInput): number;
  listRecentCommandEvents(limit: number): CommandEventRow[];
  pruneCommandEvents(opts: PruneOptions): void;

  // pre-edit advisory cooldown (warned session × conflict-picture fingerprint → last warned)
  getAdvisory(sessionId: string, fingerprint: string): number | undefined;
  recordAdvisory(sessionId: string, fingerprint: string, ts: number): void;
  pruneAdvisories(opts: AgePruneOptions): void;

  // config / state
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  close(): void;
}
