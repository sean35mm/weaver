/**
 * Runtime-aware SQLite binding adapter (the seam that keeps the rest of the store
 * runtime-agnostic). Uses `bun:sqlite` under Bun and `node:sqlite` under Node — both are
 * built in, so there is no native dependency to install. Exposes one small uniform handle.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export type SqlParam = string | number | bigint | null | Uint8Array;
type SyncTransactionResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number };
  get<T>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T>(sql: string, ...params: SqlParam[]): T[];
  /** Synchronous, non-nested transaction. */
  transaction<T>(fn: () => SyncTransactionResult<T>): SyncTransactionResult<T>;
  /** Which binding backs this handle — surfaced by `weaver doctor`. */
  readonly binding: "bun:sqlite" | "node:sqlite";
  close(): void;
}

interface RawStatement {
  run(...params: SqlParam[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

const BUSY_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160] as const;
const BUSY_TIMEOUT_MS = 250;

export interface BusyRetryOptions {
  delaysMs?: readonly number[];
  wait?: (milliseconds: number) => void;
}

function isBusyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate?.code === "SQLITE_BUSY" ||
    candidate?.code === "SQLITE_LOCKED" ||
    /(?:database|database table|database schema) is locked|SQLITE_(?:BUSY|LOCKED)/i.test(
      String(candidate?.message ?? ""),
    )
  );
}

function blockingWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Retry only SQLite lock contention; ordinary operations take the single-attempt path. */
export function withBusyRetry<T>(operation: () => T, opts: BusyRetryOptions = {}): T {
  const delays = opts.delaysMs ?? BUSY_RETRY_DELAYS_MS;
  const wait = opts.wait ?? blockingWait;
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const delay = delays[attempt];
      if (!isBusyError(error) || delay === undefined) throw error;
      wait(delay);
    }
  }
}

function wrap(raw: RawDatabase, binding: Db["binding"], retryOptions?: BusyRetryOptions): Db {
  const cache = new Map<string, RawStatement>();
  let inTransaction = false;
  const prep = (sql: string): RawStatement => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    binding,
    exec: (sql) => withBusyRetry(() => raw.exec(sql), retryOptions),
    run: (sql, ...params) => {
      const r = withBusyRetry(() => prep(sql).run(...params), retryOptions);
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: Number(r.lastInsertRowid ?? 0),
      };
    },
    get: <T>(sql: string, ...params: SqlParam[]) =>
      withBusyRetry(() => prep(sql).get(...params), retryOptions) as T | undefined,
    all: <T>(sql: string, ...params: SqlParam[]) => withBusyRetry(() => prep(sql).all(...params), retryOptions) as T[],
    transaction: <T>(fn: () => SyncTransactionResult<T>): SyncTransactionResult<T> => {
      if (inTransaction) throw new Error("nested transactions are not supported");
      if (fn.constructor.name === "AsyncFunction") throw new Error("async transactions are not supported");
      withBusyRetry(() => raw.exec("BEGIN IMMEDIATE"), retryOptions);
      inTransaction = true;
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new Error("async transactions are not supported");
        }
        withBusyRetry(() => raw.exec("COMMIT"), retryOptions);
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        inTransaction = false;
      }
    },
    close: () => raw.close(),
  };
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface OpenDbOptions {
  readOnly?: boolean;
  immutable?: boolean;
  busyRetry?: BusyRetryOptions;
}

/** Enable settings that may persist or are meaningful only for a writable store. */
export function configureWritableDb(db: Db): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
}

export async function openDb(path: string, opts: OpenDbOptions = {}): Promise<Db> {
  const readOnly = opts.readOnly ?? false;
  if (opts.immutable && !readOnly) throw new Error("immutable databases must be opened read-only");
  const immutableUrl = pathToFileURL(path);
  immutableUrl.searchParams.set("immutable", "1");
  let db: Db;
  if (isBun) {
    // @ts-expect-error - bun:sqlite is provided by the Bun runtime
    const { Database } = await import("bun:sqlite");
    // Bun cannot read a checkpointed WAL-mode database read-only after SQLite removes
    // its empty WAL/SHM files. Immutable mode is correct only when those sidecars are absent.
    const bunPath =
      opts.immutable || (readOnly && !fs.existsSync(`${path}-wal`) && !fs.existsSync(`${path}-shm`))
        ? immutableUrl.href
        : path;
    db = wrap(
      new Database(bunPath, readOnly ? { readonly: true, create: false } : { create: true }) as unknown as RawDatabase,
      "bun:sqlite",
      opts.busyRetry,
    );
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = wrap(
      new DatabaseSync(
        opts.immutable ? immutableUrl : path,
        readOnly ? { readOnly: true } : {},
      ) as unknown as RawDatabase,
      "node:sqlite",
      opts.busyRetry,
    );
  }
  try {
    // Connection-local only; persistent journal configuration is deferred until validation.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the configuration error.
    }
    throw error;
  }
}
