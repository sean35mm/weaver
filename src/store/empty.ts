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

function readonlyStoreWrite(): never {
  throw new Error("read-only empty store cannot be written");
}

/** Read-only stand-in used when observer commands run before a Weaver store exists. */
export class EmptyStore implements Store {
  transaction<T>(_fn: () => SyncTransactionResult<T>): SyncTransactionResult<T> {
    return readonlyStoreWrite();
  }

  upsertSession(_input: SessionInput, _now: number): void {
    readonlyStoreWrite();
  }

  touchSession(_id: string, _now: number): void {
    readonlyStoreWrite();
  }

  setIntent(_id: string, _intent: string, _now: number): void {
    readonlyStoreWrite();
  }

  endSession(_id: string, _now: number): void {
    readonlyStoreWrite();
  }

  getSession(_id: string): SessionRow | undefined {
    return undefined;
  }

  listSessions(_limit: number): SessionRow[] {
    return [];
  }

  listActiveSessions(_now: number, _ttlMs: number): SessionRow[] {
    return [];
  }

  listOpenSessions(): SessionRow[] {
    return [];
  }

  listRecentEndedSessions(_limit: number, _since?: number): SessionRow[] {
    return [];
  }

  addClaim(_input: ClaimInput): number {
    return readonlyStoreWrite();
  }

  releaseClaim(_sessionId: string, _pattern: string, _now: number): void;
  releaseClaim(_sessionId: string, _pattern: string, _worktreeId: string | null | undefined, _now: number): void;
  releaseClaim(
    _sessionId: string,
    _pattern: string,
    _worktreeIdOrNow: string | number | null | undefined,
    _maybeNow?: number,
  ): void {
    readonlyStoreWrite();
  }

  releaseAllClaims(_sessionId: string, _now: number): void;
  releaseAllClaims(_sessionId: string, _worktreeId: string | null | undefined, _now: number): void;
  releaseAllClaims(_sessionId: string, _worktreeIdOrNow: string | number | null | undefined, _maybeNow?: number): void {
    readonlyStoreWrite();
  }

  listActiveClaims(_now: number): ClaimRow[] {
    return [];
  }

  listClaims(_limit: number): ClaimRow[] {
    return [];
  }

  listOpenClaims(): ClaimRow[] {
    return [];
  }

  pruneClaims(_opts: ClaimPruneOptions): void {
    readonlyStoreWrite();
  }

  createScratchpad(_input: ScratchpadCreateInput): ScratchpadRow {
    return readonlyStoreWrite();
  }

  getScratchpad(_id: number): ScratchpadRow | undefined {
    return undefined;
  }

  listScratchpads(_states: ScratchpadState[] | null, _limit: number): ScratchpadRow[] {
    return [];
  }

  findScratchpads(_query: string, _states: ScratchpadState[] | null, _limit: number): ScratchpadRow[] {
    return [];
  }

  updateScratchpad(_input: ScratchpadUpdateInput): boolean {
    return readonlyStoreWrite();
  }

  addScratchpadRevision(_input: ScratchpadRevisionInput): number {
    return readonlyStoreWrite();
  }

  listScratchpadRevisions(_scratchpadId: number, _limit: number): ScratchpadRevisionRow[] {
    return [];
  }

  getScratchpadAttachment(_sessionId: string, _worktreeId: string): ScratchpadAttachmentRow | undefined {
    return undefined;
  }

  listScratchpadAttachments(_scratchpadId?: number): ScratchpadAttachmentRow[] {
    return [];
  }

  attachScratchpad(_input: ScratchpadAttachmentInput): number {
    return readonlyStoreWrite();
  }

  detachScratchpad(_sessionId: string, _worktreeId: string, _now: number): void {
    readonlyStoreWrite();
  }

  addNote(_input: NoteInput): number {
    return readonlyStoreWrite();
  }

  getNote(_id: number): NoteRow | undefined {
    return undefined;
  }

  listNotes(_limit: number): NoteRow[] {
    return [];
  }

  listAllNotes(_limit: number): NoteRow[] {
    return [];
  }

  retireNote(_id: number, _retiredBy: string, _reason: string, _now: number): void {
    readonlyStoreWrite();
  }

  restoreNote(_id: number): void {
    readonlyStoreWrite();
  }

  addActivity(_input: ActivityInput): number {
    return readonlyStoreWrite();
  }

  listRecentActivity(_limit: number): ActivityRow[] {
    return [];
  }

  pruneActivity(_opts: PruneOptions): void {
    readonlyStoreWrite();
  }

  addCommandEvent(_input: CommandEventInput): number {
    return readonlyStoreWrite();
  }

  listRecentCommandEvents(_limit: number): CommandEventRow[] {
    return [];
  }

  pruneCommandEvents(_opts: PruneOptions): void {
    readonlyStoreWrite();
  }

  getAdvisory(_sessionId: string, _fingerprint: string): number | undefined {
    return undefined;
  }

  recordAdvisory(_sessionId: string, _fingerprint: string, _ts: number): void {
    readonlyStoreWrite();
  }

  pruneAdvisories(_opts: AgePruneOptions): void {
    readonlyStoreWrite();
  }

  getDashboardLease(_scopeId: string): DashboardLeaseRow | undefined {
    return undefined;
  }

  tryAcquireDashboardLease(_input: DashboardLeaseInput): boolean {
    return readonlyStoreWrite();
  }

  renewDashboardLease(_input: DashboardLeaseInput): boolean {
    return readonlyStoreWrite();
  }

  releaseDashboardLease(_scopeId: string, _ownerId: string): boolean {
    return readonlyStoreWrite();
  }

  getMeta(_key: string): string | undefined {
    return undefined;
  }

  setMeta(_key: string, _value: string): void {
    readonlyStoreWrite();
  }

  close(): void {
    /* no-op */
  }
}
