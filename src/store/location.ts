/** Where the per-repo store lives on disk. Global, keyed by repo identity. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRuntimePath, PRIVATE_FILE_MODE } from "./runtime.ts";

/** Root for all Weaver stores. `WEAVER_HOME` overrides (useful for tests). */
export function weaverDir(): string {
  return process.env.WEAVER_HOME ?? path.join(os.homedir(), ".weaver");
}

export function storePathForRepo(repoId: string): string {
  return path.join(weaverDir(), `${repoId}.db`);
}

export function ensureWeaverDir(
  explicitHome = process.env.WEAVER_HOME,
  defaultDir = path.join(os.homedir(), ".weaver"),
): string {
  const dir = explicitHome ?? defaultDir;
  if (explicitHome === undefined) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isDefaultStorePath(dbPath: string, explicitHome: string | undefined, defaultDir: string): boolean {
  return explicitHome === undefined && canonicalRuntimePath(path.dirname(dbPath)) === canonicalRuntimePath(defaultDir);
}

/** Securely create the private default DB before SQLite can create it under a permissive umask. */
export function prepareDefaultStoreFile(
  dbPath: string,
  explicitHome = process.env.WEAVER_HOME,
  defaultDir = path.join(os.homedir(), ".weaver"),
): void {
  if (!isDefaultStorePath(dbPath, explicitHome, defaultDir)) return;
  fs.chmodSync(path.dirname(dbPath), 0o700);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      dbPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`store path is not a regular file: ${dbPath}`);
    fs.chmodSync(dbPath, PRIVATE_FILE_MODE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Harden only Weaver's private default store; explicit WEAVER_HOME locations may be shared. */
export function hardenDefaultStore(
  dbPath: string,
  explicitHome = process.env.WEAVER_HOME,
  defaultDir = path.join(os.homedir(), ".weaver"),
): void {
  if (!isDefaultStorePath(dbPath, explicitHome, defaultDir)) return;
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`store artifact is not a regular file: ${file}`);
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  }
}
