/**
 * Runtime-aware SQLite binding adapter (the seam that keeps the rest of the store
 * runtime-agnostic). Uses `bun:sqlite` under Bun and `node:sqlite` under Node — both are
 * built in, so there is no native dependency to install. Exposes one small uniform handle.
 */

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

function wrap(raw: RawDatabase, binding: Db["binding"]): Db {
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
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => {
      const r = prep(sql).run(...params);
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: Number(r.lastInsertRowid ?? 0),
      };
    },
    get: <T>(sql: string, ...params: SqlParam[]) => prep(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlParam[]) => prep(sql).all(...params) as T[],
    transaction: <T>(fn: () => SyncTransactionResult<T>): SyncTransactionResult<T> => {
      if (inTransaction) throw new Error("nested transactions are not supported");
      if (fn.constructor.name === "AsyncFunction") throw new Error("async transactions are not supported");
      raw.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new Error("async transactions are not supported");
        }
        raw.exec("COMMIT");
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

export async function openDb(path: string): Promise<Db> {
  let db: Db;
  if (isBun) {
    // @ts-ignore - bun:sqlite is provided by the Bun runtime
    const { Database } = await import("bun:sqlite");
    db = wrap(new Database(path, { create: true }) as unknown as RawDatabase, "bun:sqlite");
  } else {
    // @ts-ignore - node:sqlite is a built-in module (Node >= 22.5)
    const { DatabaseSync } = await import("node:sqlite");
    db = wrap(new DatabaseSync(path) as unknown as RawDatabase, "node:sqlite");
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
