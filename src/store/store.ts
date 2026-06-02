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
  "join",
  "done",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type SyncTransactionResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface SessionInput {
  id: string;
  harness: string;
  idSource: IdSource;
  pid: number | null;
  cwd: string | null;
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
}

export interface ActivityInput {
  sessionId: string;
  ts: number;
  kind: ActivityKind;
  target: string | null;
  summary: string | null;
  meta: string | null;
}

export interface ActivityRow extends ActivityInput {
  id: number;
}

export interface PruneOptions {
  maxEvents: number;
  maxAgeDays: number;
  now: number;
}

export interface ClaimPruneOptions {
  maxAgeDays: number;
  now: number;
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
  /** Live = not ended and seen within `ttlMs`. */
  listActiveSessions(now: number, ttlMs: number): SessionRow[];
  listRecentEndedSessions(limit: number, since?: number): SessionRow[];

  // claims (advisory, TTL'd, co-claims allowed)
  addClaim(input: ClaimInput): number;
  releaseClaim(sessionId: string, pattern: string, now: number): void;
  releaseAllClaims(sessionId: string, now: number): void;
  /** Not released and not expired at `now`. */
  listActiveClaims(now: number): ClaimRow[];
  /** Not released, regardless of expiry — used by conflict detection to surface stale holds. */
  listOpenClaims(): ClaimRow[];
  pruneClaims(opts: ClaimPruneOptions): void;

  // notes (durable, repo-scoped)
  addNote(input: NoteInput): number;
  listNotes(limit: number): NoteRow[];

  // activity (time-ordered; pruned lazily)
  addActivity(input: ActivityInput): number;
  listRecentActivity(limit: number): ActivityRow[];
  pruneActivity(opts: PruneOptions): void;

  // config / state
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  close(): void;
}
