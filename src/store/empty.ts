import type {
  ActivityInput,
  ActivityRow,
  AgePruneOptions,
  ClaimInput,
  ClaimPruneOptions,
  ClaimRow,
  CommandEventInput,
  CommandEventRow,
  NoteInput,
  NoteRow,
  PruneOptions,
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

  releaseClaim(_sessionId: string, _pattern: string, _now: number): void {
    readonlyStoreWrite();
  }

  releaseAllClaims(_sessionId: string, _now: number): void {
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
