/** Open (and migrate) a store at a given path. */

import fs from "node:fs";
import type { Db, SqlParam } from "./db.ts";
import { configureWritableDb, openDb, withBusyRetry } from "./db.ts";
import { hardenDefaultStore, prepareDefaultStoreFile } from "./location.ts";
import { inspectSchemaCompatibility, migrate } from "./schema.ts";
import { SqliteStore } from "./sqlite.ts";
import type { Store } from "./store.ts";

interface StoreLocationOptions {
  /** The actual WEAVER_HOME value; undefined means Weaver's private default home. */
  explicitHome: string | undefined;
  /** Canonical default home selected by the holder protocol. */
  defaultHome?: string;
}

export interface OpenStoreOptions {
  readOnly?: boolean;
  migrate?: boolean;
  location?: StoreLocationOptions;
}

interface RawReadStatement {
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

interface RawReadDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawReadStatement;
  close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function openCompatibilityReader(dbPath: string): Promise<Db> {
  let raw: RawReadDatabase;
  let binding: Db["binding"];
  if (isBun) {
    // @ts-expect-error - bun:sqlite is provided by the Bun runtime
    const { Database } = await import("bun:sqlite");
    raw = new Database(dbPath, { readonly: true, create: false }) as unknown as RawReadDatabase;
    binding = "bun:sqlite";
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    raw = new DatabaseSync(dbPath, { readOnly: true }) as unknown as RawReadDatabase;
    binding = "node:sqlite";
  }
  try {
    raw.exec("PRAGMA busy_timeout = 250");
  } catch (error) {
    raw.close();
    throw error;
  }
  return {
    binding,
    exec: (sql) => withBusyRetry(() => raw.exec(sql)),
    get: <T>(sql: string, ...params: SqlParam[]) =>
      withBusyRetry(() => raw.prepare(sql).get(...params)) as T | undefined,
    all: <T>(sql: string, ...params: SqlParam[]) => withBusyRetry(() => raw.prepare(sql).all(...params)) as T[],
    run: () => {
      throw new Error("compatibility reader is read-only");
    },
    transaction: () => {
      throw new Error("compatibility reader does not support transactions");
    },
    close: () => raw.close(),
  };
}

function existingRegularFile(dbPath: string): { exists: boolean; size: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dbPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`store path is not a regular file: ${dbPath}`);
    return { exists: true, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0 };
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function preflightExistingStore(dbPath: string): Promise<boolean> {
  const file = existingRegularFile(dbPath);
  // Another admitted holder may have securely created the file but not initialized SQLite yet.
  // The writable handle and migration transaction remain the authoritative compatibility gates.
  if (!file.exists || file.size === 0) return file.exists;
  let reader: Db | undefined;
  try {
    reader = await openCompatibilityReader(dbPath);
    inspectSchemaCompatibility(reader);
    return true;
  } catch (error) {
    reader?.close();
    reader = undefined;
    const candidate = error as { code?: unknown; message?: unknown };
    const hasSidecars = (): boolean => fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`);
    // Bun cannot normally open a fully checkpointed WAL-mode DB read-only after SQLite removes
    // both sidecars. Only that quiescent, sidecar-free case gets an immutable compatibility read;
    // live or stale WAL always stays on the lock-aware path above.
    if (
      !isBun ||
      (candidate.code !== "SQLITE_CANTOPEN" &&
        !/unable to open database file/i.test(String(candidate.message ?? ""))) ||
      hasSidecars()
    ) {
      throw error;
    }
    const quiescentReader = await openDb(dbPath, { readOnly: true, immutable: true });
    try {
      inspectSchemaCompatibility(quiescentReader);
    } finally {
      quiescentReader.close();
    }
    if (hasSidecars()) {
      const lockAwareReader = await openCompatibilityReader(dbPath);
      try {
        inspectSchemaCompatibility(lockAwareReader);
      } finally {
        lockAwareReader.close();
      }
    }
    return true;
  } finally {
    reader?.close();
  }
}

export async function openStore(dbPath: string, opts: OpenStoreOptions = {}): Promise<Store> {
  const explicitHome = opts.location ? opts.location.explicitHome : process.env.WEAVER_HOME;
  const defaultHome = opts.location?.defaultHome;
  const existingFile = existingRegularFile(dbPath);
  if (existingFile.exists) hardenDefaultStore(dbPath, explicitHome, defaultHome);
  if (!opts.readOnly) {
    await preflightExistingStore(dbPath);
    prepareDefaultStoreFile(dbPath, explicitHome, defaultHome);
    hardenDefaultStore(dbPath, explicitHome, defaultHome);
  }
  const db = await openDb(dbPath, { readOnly: opts.readOnly });
  try {
    inspectSchemaCompatibility(db);
    hardenDefaultStore(dbPath, explicitHome, defaultHome);
    if (opts.migrate ?? !opts.readOnly) db.transaction(() => migrate(db));
    if (!opts.readOnly) configureWritableDb(db);
    hardenDefaultStore(dbPath, explicitHome, defaultHome);
    return new SqliteStore(db);
  } catch (error) {
    let failure = error;
    try {
      hardenDefaultStore(dbPath, explicitHome, defaultHome);
    } catch (hardeningError) {
      failure = hardeningError;
    }
    try {
      db.close();
    } catch {
      // Preserve the validation, migration, or configuration error.
    }
    try {
      hardenDefaultStore(dbPath, explicitHome, defaultHome);
    } catch (hardeningError) {
      failure = hardeningError;
    }
    throw failure;
  }
}
