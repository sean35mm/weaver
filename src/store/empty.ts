import type {
  ActivityInput,
  ActivityRow,
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

  listActiveSessions(_now: number, _ttlMs: number): SessionRow[] {
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

  listOpenClaims(): ClaimRow[] {
    return [];
  }

  pruneClaims(_opts: ClaimPruneOptions): void {
    readonlyStoreWrite();
  }

  addNote(_input: NoteInput): number {
    return readonlyStoreWrite();
  }

  listNotes(_limit: number): NoteRow[] {
    return [];
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
