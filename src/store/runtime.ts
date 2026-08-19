import { createHash, randomUUID } from "node:crypto";
import fs, { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const STORE_RUNTIME_PROTOCOL = 1;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const HOME_METADATA = ".home-scope.json";
const STORE_METADATA = ".store-scope.json";
const MAX_SCOPE_METADATA_BYTES = 2048;

export interface RuntimeScopeOptions {
  weaverHome?: string;
  defaultWeaverHome?: string;
  tmpDir?: string;
  uid?: number | null;
}

export interface StoreRuntimeScopeOptions extends RuntimeScopeOptions {
  repoId: string;
}

export interface HomeRuntimePaths {
  canonicalHome: string;
  uid: number;
  scopeId: string;
  directory: string;
  storesDirectory: string;
}

export interface StoreRuntimePaths extends HomeRuntimePaths {
  repoId: string;
  storeScopeId: string;
  storeDirectory: string;
  holdersDirectory: string;
  storePath: string;
}

interface HomeScopeMetadata {
  protocol: typeof STORE_RUNTIME_PROTOCOL;
  canonicalHome: string;
  uid: number;
  scopeId: string;
}

interface StoreScopeMetadata {
  protocol: typeof STORE_RUNTIME_PROTOCOL;
  homeScopeId: string;
  repoId: string;
  storeScopeId: string;
}

function shortHash(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("base64url").slice(0, 8);
}

function effectiveUid(explicit: number | null | undefined): number {
  const uid = explicit === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : explicit;
  if (uid === null || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("store coordination requires a numeric user id");
  }
  return uid;
}

/** Resolve symlinked existing ancestors while retaining a not-yet-created suffix. */
export function canonicalRuntimePath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function homeRuntimePaths(options: RuntimeScopeOptions = {}): HomeRuntimePaths {
  if (process.platform === "win32") throw new Error("store coordination is not supported on native Windows");
  const home =
    options.weaverHome ?? process.env.WEAVER_HOME ?? options.defaultWeaverHome ?? path.join(os.homedir(), ".weaver");
  const canonicalHome = canonicalRuntimePath(home);
  const uid = effectiveUid(options.uid);
  const scopeId = shortHash(canonicalHome, String(uid));
  const runtimeRoot = canonicalRuntimePath(options.tmpDir ?? "/tmp");
  const directory = path.join(runtimeRoot, `w${uid}`, `h${scopeId}`);
  return {
    canonicalHome,
    uid,
    scopeId,
    directory,
    storesDirectory: path.join(directory, "s"),
  };
}

export function storeRuntimePaths(options: StoreRuntimeScopeOptions): StoreRuntimePaths {
  if (!options.repoId || options.repoId.length > 256 || options.repoId.includes("\0")) {
    throw new Error("invalid store repository id");
  }
  const home = homeRuntimePaths(options);
  const storeScopeId = `s${shortHash(home.scopeId, options.repoId)}`;
  const storeDirectory = path.join(home.storesDirectory, storeScopeId);
  return {
    ...home,
    repoId: options.repoId,
    storeScopeId,
    storeDirectory,
    holdersDirectory: path.join(storeDirectory, "holders"),
    storePath: path.join(home.canonicalHome, `${options.repoId}.db`),
  };
}

export function assertPrivateDirectory(directory: string, uid: number): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`runtime path is not a directory: ${directory}`);
  if (stat.uid !== uid) throw new Error(`runtime directory is not owned by uid ${uid}: ${directory}`);
  if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`runtime path is not a directory or is not private: ${directory}`);
  }
}

function ensurePrivateDirectory(directory: string, uid: number): void {
  try {
    fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(directory, uid);
}

function readPrivateMetadata(filePath: string, uid: number): unknown {
  const fd = fs.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SCOPE_METADATA_BYTES) {
      throw new Error(`invalid runtime metadata: ${filePath}`);
    }
    if (stat.uid !== uid || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error(`runtime metadata is not private: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

function sameRecord(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index] && record[key] === expected[key])
  );
}

function ensureImmutableMetadata(filePath: string, metadata: object, uid: number): void {
  const body = JSON.stringify(metadata);
  if (Buffer.byteLength(body) > MAX_SCOPE_METADATA_BYTES) throw new Error("runtime metadata is too large");
  const artifact = path.join(path.dirname(filePath), `.scope-owner-${randomUUID()}.json`);
  const fd = fs.openSync(artifact, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
  try {
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(artifact, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.unlinkSync(artifact);
  }
  if (!sameRecord(readPrivateMetadata(filePath, uid), metadata as Record<string, unknown>)) {
    throw new Error(`runtime metadata does not match its namespace: ${filePath}`);
  }
}

export function ensureHomeRuntime(options: RuntimeScopeOptions = {}): HomeRuntimePaths {
  const runtime = homeRuntimePaths(options);
  ensurePrivateDirectory(path.dirname(runtime.directory), runtime.uid);
  ensurePrivateDirectory(runtime.directory, runtime.uid);
  const metadata: HomeScopeMetadata = {
    protocol: STORE_RUNTIME_PROTOCOL,
    canonicalHome: runtime.canonicalHome,
    uid: runtime.uid,
    scopeId: runtime.scopeId,
  };
  ensureImmutableMetadata(path.join(runtime.directory, HOME_METADATA), metadata, runtime.uid);
  ensurePrivateDirectory(runtime.storesDirectory, runtime.uid);
  return runtime;
}

export function ensureStoreRuntime(options: StoreRuntimeScopeOptions): StoreRuntimePaths {
  const runtime = storeRuntimePaths(options);
  ensureHomeRuntime(options);
  ensurePrivateDirectory(runtime.storeDirectory, runtime.uid);
  const metadata: StoreScopeMetadata = {
    protocol: STORE_RUNTIME_PROTOCOL,
    homeScopeId: runtime.scopeId,
    repoId: runtime.repoId,
    storeScopeId: runtime.storeScopeId,
  };
  ensureImmutableMetadata(path.join(runtime.storeDirectory, STORE_METADATA), metadata, runtime.uid);
  ensurePrivateDirectory(runtime.holdersDirectory, runtime.uid);
  return runtime;
}

export function readStoreRuntimeRepoId(home: HomeRuntimePaths, storeDirectory: string): string {
  assertPrivateDirectory(storeDirectory, home.uid);
  const value = readPrivateMetadata(path.join(storeDirectory, STORE_METADATA), home.uid);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid store runtime metadata");
  const record = value as Record<string, unknown>;
  const expectedKeys = ["homeScopeId", "protocol", "repoId", "storeScopeId"];
  if (
    Object.keys(record)
      .sort()
      .some((key, index) => key !== expectedKeys[index]) ||
    Object.keys(record).length !== expectedKeys.length ||
    record.protocol !== STORE_RUNTIME_PROTOCOL ||
    record.homeScopeId !== home.scopeId ||
    typeof record.repoId !== "string" ||
    record.repoId.length === 0 ||
    record.repoId.length > 256 ||
    record.storeScopeId !== path.basename(storeDirectory) ||
    record.storeScopeId !== `s${shortHash(home.scopeId, record.repoId)}`
  ) {
    throw new Error("invalid store runtime metadata");
  }
  return record.repoId;
}
