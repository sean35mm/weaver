import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertPrivateDirectory,
  ensureHomeRuntime,
  ensureStoreRuntime,
  type HomeRuntimePaths,
  homeRuntimePaths,
  PRIVATE_FILE_MODE,
  type RuntimeScopeOptions,
  readStoreRuntimeRepoId,
  type StoreRuntimePaths,
  type StoreRuntimeScopeOptions,
} from "./runtime.ts";

export const STORE_COORDINATION_PROTOCOL = 1;
const MAX_METADATA_BYTES = 4096;
const HOLDER_PREFIX = ".holder-";
const HOLDER_RELEASE_PREFIX = ".holder-release-";
const FENCE_PREFIX = ".maintenance-fence-";
const FENCE_RELEASE_PREFIX = ".maintenance-release-";
const FENCE_OWNER_PREFIX = ".maintenance-owner-";
const FENCE_RELEASE_OWNER_PREFIX = ".maintenance-owner-release-";
const GENERATION_WIDTH = 16;
const RELEASED_FENCE_RETENTION = 2;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_REPO_ID = /^[A-Za-z0-9_-]{1,256}$/;

export type MaintenanceReason = "purge" | "uninstall";
export type MaintenanceScope = "store" | "home";

export interface StoreHolderMetadata {
  protocol: typeof STORE_COORDINATION_PROTOCOL;
  holderId: string;
  repoId: string;
  pid: number;
  processStartId: string | null;
  createdAt: number;
  command: string;
}

export interface StoreHolderHandle {
  metadata: StoreHolderMetadata;
  runtime: StoreRuntimePaths;
  release(): Promise<void>;
}

export interface RegisterStoreHolderOptions extends StoreRuntimeScopeOptions {
  command: string;
  pid?: number;
  now?: () => number;
  randomId?: () => string;
  processStartId?: (pid: number) => string | undefined;
}

export interface MaintenanceMetadata {
  protocol: typeof STORE_COORDINATION_PROTOCOL;
  fenceId: string;
  scope: MaintenanceScope;
  repoId: string | null;
  pid: number;
  processStartId: string | null;
  createdAt: number;
  reason: MaintenanceReason;
  generation: number;
}

export interface MaintenanceHandle {
  acquired: true;
  metadata: MaintenanceMetadata;
  runtime: HomeRuntimePaths | StoreRuntimePaths;
  directory: string;
  release(): Promise<void>;
  revalidate(): Promise<boolean>;
}

export interface MaintenanceBlocked {
  acquired: false;
  metadata?: MaintenanceMetadata;
  error?: string;
}

export type MaintenanceAcquisition = MaintenanceHandle | MaintenanceBlocked;

export interface MaintenanceOptions extends RuntimeScopeOptions {
  reason: MaintenanceReason;
  pid?: number;
  now?: () => number;
  randomId?: () => string;
  processStartId?: (pid: number) => string | undefined;
  inspectProcess?: (
    metadata: Pick<StoreHolderMetadata, "pid" | "processStartId">,
  ) => ProcessState | Promise<ProcessState>;
}

export interface StoreMaintenanceOptions extends MaintenanceOptions {
  repoId: string;
}

export type ProcessState = "matching" | "absent" | "reused" | "indeterminate";

export interface DrainOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  inspectProcess?: (
    metadata: Pick<StoreHolderMetadata, "pid" | "processStartId">,
  ) => ProcessState | Promise<ProcessState>;
}

export type DrainResult = { ok: true } | { ok: false; error: string };

interface HolderReleaseMetadata {
  protocol: typeof STORE_COORDINATION_PROTOCOL;
  holderId: string;
  repoId: string;
  releasedAt: number;
}

interface FenceReleaseMetadata {
  protocol: typeof STORE_COORDINATION_PROTOCOL;
  fenceId: string;
  generation: number;
  releasedAt: number;
}

interface FenceState {
  fence?: MaintenanceMetadata;
  released: boolean;
}

interface CoordinationFileIdentity {
  dev: number;
  ino: number;
}

interface ActiveHolder {
  identity: CoordinationFileIdentity;
  metadata: StoreHolderMetadata;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function validInteger(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function normalizedCommand(command: string): string {
  let value = "";
  for (const character of command) {
    const codePoint = character.codePointAt(0) ?? 0;
    value += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  value = value.trim();
  return value.slice(0, 512) || "weaver";
}

function linuxProcessStartId(pid: number): string | undefined {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const close = stat.lastIndexOf(")");
    if (!/^[0-9a-f-]{16,}$/i.test(bootId) || close < 2) return undefined;
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^\d+$/.test(startTime)) return undefined;
    return `linux:${bootId.toLowerCase()}:${startTime}`;
  } catch {
    return undefined;
  }
}

function unixProcessStartId(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 500,
    maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) return undefined;
  const value = result.stdout.trim().replace(/\s+/g, " ");
  return value && value.length <= 128 ? `unix:${value}` : undefined;
}

export function getProcessStartId(pid = process.pid): string | undefined {
  if (!validInteger(pid, true)) return undefined;
  return process.platform === "linux" ? linuxProcessStartId(pid) : unixProcessStartId(pid);
}

function pidLiveness(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "ESRCH") ? false : undefined;
  }
}

export function inspectHolderProcess(metadata: Pick<StoreHolderMetadata, "pid" | "processStartId">): ProcessState {
  const alive = pidLiveness(metadata.pid);
  if (alive === false) return "absent";
  if (alive !== true || metadata.processStartId === null) return "indeterminate";
  const current = getProcessStartId(metadata.pid);
  if (current === undefined) return "indeterminate";
  return current === metadata.processStartId ? "matching" : "reused";
}

async function readPrivateJsonWithIdentity(
  filePath: string,
  uid: number,
): Promise<{ identity: CoordinationFileIdentity; value: unknown }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_METADATA_BYTES)
      throw new Error("invalid coordination metadata");
    if (stat.uid !== uid || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("coordination metadata is not private");
    }
    return {
      identity: { dev: stat.dev, ino: stat.ino },
      value: JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown,
    };
  } finally {
    await handle.close();
  }
}

async function readPrivateJson(filePath: string, uid: number): Promise<unknown> {
  return (await readPrivateJsonWithIdentity(filePath, uid)).value;
}

async function writeImmutableJson(filePath: string, value: object): Promise<void> {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_METADATA_BYTES) throw new Error("coordination metadata is too large");
  const handle = await fs.open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(body, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validateHolder(value: unknown, repoId?: string): StoreHolderMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid store holder metadata");
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["protocol", "holderId", "repoId", "pid", "processStartId", "createdAt", "command"]) ||
    record.protocol !== STORE_COORDINATION_PROTOCOL ||
    typeof record.holderId !== "string" ||
    !SAFE_ID.test(record.holderId) ||
    typeof record.repoId !== "string" ||
    !SAFE_REPO_ID.test(record.repoId) ||
    (repoId !== undefined && record.repoId !== repoId) ||
    !validInteger(record.pid, true) ||
    (record.processStartId !== null &&
      (typeof record.processStartId !== "string" ||
        record.processStartId.length === 0 ||
        record.processStartId.length > 256)) ||
    !validInteger(record.createdAt) ||
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    record.command.length > 512
  ) {
    throw new Error("invalid store holder metadata");
  }
  return record as unknown as StoreHolderMetadata;
}

function validateHolderRelease(value: unknown, holder: StoreHolderMetadata): HolderReleaseMetadata {
  const release = validateHolderReleaseForRepo(value, holder.holderId, holder.repoId);
  return release;
}

function validateHolderReleaseForRepo(value: unknown, holderId: string, repoId: string): HolderReleaseMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid holder release metadata");
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["protocol", "holderId", "repoId", "releasedAt"]) ||
    record.protocol !== STORE_COORDINATION_PROTOCOL ||
    record.holderId !== holderId ||
    record.repoId !== repoId ||
    !validInteger(record.releasedAt)
  ) {
    throw new Error("holder release does not match its holder");
  }
  return record as unknown as HolderReleaseMetadata;
}

function holderPath(runtime: StoreRuntimePaths, holderId: string): string {
  return path.join(runtime.holdersDirectory, `${HOLDER_PREFIX}${holderId}.json`);
}

function holderReleasePath(runtime: StoreRuntimePaths, holderId: string): string {
  return path.join(runtime.holdersDirectory, `${HOLDER_RELEASE_PREFIX}${holderId}.json`);
}

async function releaseHolder(
  runtime: StoreRuntimePaths,
  expected: StoreHolderMetadata,
  expectedIdentity: CoordinationFileIdentity,
): Promise<void> {
  let current: StoreHolderMetadata;
  let currentIdentity: CoordinationFileIdentity;
  try {
    const file = await readPrivateJsonWithIdentity(holderPath(runtime, expected.holderId), runtime.uid);
    current = validateHolder(file.value, runtime.repoId);
    currentIdentity = file.identity;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (
    JSON.stringify(current) !== JSON.stringify(expected) ||
    currentIdentity.dev !== expectedIdentity.dev ||
    currentIdentity.ino !== expectedIdentity.ino
  ) {
    throw new Error("store holder ownership changed");
  }
  try {
    await fs.unlink(holderPath(runtime, expected.holderId));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function generationName(prefix: string, generation: number): string {
  return `${prefix}${String(generation).padStart(GENERATION_WIDTH, "0")}.json`;
}

function fencePath(directory: string, generation: number): string {
  return path.join(directory, generationName(FENCE_PREFIX, generation));
}

function fenceReleasePath(directory: string, generation: number): string {
  return path.join(directory, generationName(FENCE_RELEASE_PREFIX, generation));
}

function parseGeneration(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!new RegExp(`^\\d{${GENERATION_WIDTH}}\\.json$`).test(suffix)) throw new Error("malformed maintenance filename");
  const generation = Number(suffix.slice(0, GENERATION_WIDTH));
  if (!Number.isSafeInteger(generation)) throw new Error("invalid maintenance generation");
  return generation;
}

function validateFence(value: unknown, generation: number): MaintenanceMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid maintenance metadata");
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "protocol",
      "fenceId",
      "scope",
      "repoId",
      "pid",
      "processStartId",
      "createdAt",
      "reason",
      "generation",
    ]) ||
    record.protocol !== STORE_COORDINATION_PROTOCOL ||
    typeof record.fenceId !== "string" ||
    !SAFE_ID.test(record.fenceId) ||
    (record.scope !== "home" && record.scope !== "store") ||
    (record.scope === "home"
      ? record.repoId !== null
      : typeof record.repoId !== "string" || !SAFE_REPO_ID.test(record.repoId)) ||
    !validInteger(record.pid, true) ||
    (record.processStartId !== null &&
      (typeof record.processStartId !== "string" ||
        record.processStartId.length === 0 ||
        record.processStartId.length > 256)) ||
    !validInteger(record.createdAt) ||
    (record.reason !== "purge" && record.reason !== "uninstall") ||
    record.generation !== generation
  ) {
    throw new Error("invalid maintenance metadata");
  }
  return record as unknown as MaintenanceMetadata;
}

function validateFenceRelease(value: unknown, fence: MaintenanceMetadata): FenceReleaseMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid maintenance release");
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["protocol", "fenceId", "generation", "releasedAt"]) ||
    record.protocol !== STORE_COORDINATION_PROTOCOL ||
    record.fenceId !== fence.fenceId ||
    record.generation !== fence.generation ||
    !validInteger(record.releasedAt)
  ) {
    throw new Error("maintenance release does not match its fence");
  }
  return record as unknown as FenceReleaseMetadata;
}

async function readFenceState(directory: string, uid: number): Promise<FenceState> {
  assertPrivateDirectory(directory, uid);
  const names = await fs.readdir(directory);
  let latest = -1;
  for (const name of names) {
    const generation = parseGeneration(name, FENCE_PREFIX);
    if (generation !== undefined) latest = Math.max(latest, generation);
    else if (name.startsWith(FENCE_RELEASE_PREFIX)) parseGeneration(name, FENCE_RELEASE_PREFIX);
  }
  if (latest < 0) return { released: false };
  const fence = validateFence(await readPrivateJson(fencePath(directory, latest), uid), latest);
  try {
    validateFenceRelease(await readPrivateJson(fenceReleasePath(directory, latest), uid), fence);
    return { fence, released: true };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { fence, released: false };
    throw error;
  }
}

async function activeFence(directory: string, uid: number): Promise<MaintenanceMetadata | undefined> {
  const state = await readFenceState(directory, uid);
  return state.fence && !state.released ? state.fence : undefined;
}

async function publishFence(directory: string, metadata: MaintenanceMetadata): Promise<boolean> {
  const artifact = path.join(directory, `${FENCE_OWNER_PREFIX}${metadata.fenceId}.json`);
  await writeImmutableJson(artifact, metadata);
  try {
    await fs.link(artifact, fencePath(directory, metadata.generation));
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  } finally {
    await fs.unlink(artifact).catch(() => undefined);
  }
}

async function publishFenceRelease(
  directory: string,
  uid: number,
  expected: MaintenanceMetadata,
  releasedAt: number,
): Promise<void> {
  const current = validateFence(
    await readPrivateJson(fencePath(directory, expected.generation), uid),
    expected.generation,
  );
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("maintenance fence ownership changed");
  const release: FenceReleaseMetadata = {
    protocol: STORE_COORDINATION_PROTOCOL,
    fenceId: expected.fenceId,
    generation: expected.generation,
    releasedAt,
  };
  const artifact = path.join(
    directory,
    `${FENCE_RELEASE_OWNER_PREFIX}${String(expected.generation).padStart(GENERATION_WIDTH, "0")}-${expected.fenceId}.json`,
  );
  try {
    await writeImmutableJson(artifact, release);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    validateFenceRelease(await readPrivateJson(artifact, uid), expected);
  }
  try {
    await fs.link(artifact, fenceReleasePath(directory, expected.generation));
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    validateFenceRelease(await readPrivateJson(fenceReleasePath(directory, expected.generation), uid), expected);
  } finally {
    await fs.unlink(artifact).catch(() => undefined);
  }
}

async function compactReleasedFences(directory: string, uid: number, current: MaintenanceMetadata): Promise<void> {
  const names = new Set(await fs.readdir(directory));
  const oldestRetained = current.generation - RELEASED_FENCE_RETENTION;
  const generations = [...names]
    .map((name) => parseGeneration(name, FENCE_PREFIX))
    .filter((generation): generation is number => generation !== undefined && generation < oldestRetained)
    .sort((left, right) => left - right);
  for (const generation of generations) {
    const fenceName = generationName(FENCE_PREFIX, generation);
    const releaseName = generationName(FENCE_RELEASE_PREFIX, generation);
    if (!names.has(fenceName) || !names.has(releaseName)) continue;
    const fence = validateFence(await readPrivateJson(path.join(directory, fenceName), uid), generation);
    validateFenceRelease(await readPrivateJson(path.join(directory, releaseName), uid), fence);
    const active = await activeFence(directory, uid);
    if (!active || JSON.stringify(active) !== JSON.stringify(current)) {
      throw new Error("maintenance fence ownership changed during compaction");
    }
    await fs.unlink(path.join(directory, releaseName)).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
    await fs.unlink(path.join(directory, fenceName)).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

function blocked(error?: string, metadata?: MaintenanceMetadata): MaintenanceBlocked {
  return { acquired: false, ...(metadata ? { metadata } : {}), ...(error ? { error } : {}) };
}

async function acquireFence(
  runtime: HomeRuntimePaths | StoreRuntimePaths,
  directory: string,
  scope: MaintenanceScope,
  repoId: string | null,
  options: MaintenanceOptions,
): Promise<MaintenanceAcquisition> {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const randomId = options.randomId ?? randomUUID;
  const processStart = options.processStartId ?? getProcessStartId;
  const inspect = options.inspectProcess ?? inspectHolderProcess;
  if (!validInteger(pid, true)) return blocked("invalid maintenance process id");
  for (;;) {
    let state: FenceState;
    try {
      state = await readFenceState(directory, runtime.uid);
    } catch (error) {
      return blocked((error as Error).message);
    }
    if (state.fence && !state.released) {
      const ownerState = await Promise.resolve(inspect(state.fence)).catch(() => "indeterminate" as const);
      if (ownerState !== "absent" && ownerState !== "reused")
        return blocked("maintenance is already active", state.fence);
      try {
        await publishFenceRelease(directory, runtime.uid, state.fence, now());
      } catch (error) {
        return blocked((error as Error).message, state.fence);
      }
      continue;
    }
    const generation = state.fence ? state.fence.generation + 1 : 0;
    if (!Number.isSafeInteger(generation)) return blocked("maintenance generation exhausted", state.fence);
    const fenceId = randomId();
    if (!SAFE_ID.test(fenceId)) return blocked("invalid maintenance owner id", state.fence);
    const metadata: MaintenanceMetadata = {
      protocol: STORE_COORDINATION_PROTOCOL,
      fenceId,
      scope,
      repoId,
      pid,
      processStartId: processStart(pid) ?? null,
      createdAt: now(),
      reason: options.reason,
      generation,
    };
    try {
      if (!(await publishFence(directory, metadata))) continue;
    } catch (error) {
      return blocked((error as Error).message, state.fence);
    }
    try {
      await compactReleasedFences(directory, runtime.uid, metadata);
    } catch (error) {
      await publishFenceRelease(directory, runtime.uid, metadata, now()).catch(() => undefined);
      return blocked((error as Error).message, metadata);
    }
    let releasePromise: Promise<void> | undefined;
    return {
      acquired: true,
      metadata,
      runtime,
      directory,
      release(): Promise<void> {
        releasePromise ??= publishFenceRelease(directory, runtime.uid, metadata, now());
        return releasePromise;
      },
      async revalidate(): Promise<boolean> {
        try {
          const current = await activeFence(directory, runtime.uid);
          return current !== undefined && JSON.stringify(current) === JSON.stringify(metadata);
        } catch {
          return false;
        }
      },
    };
  }
}

export async function registerStoreHolder(options: RegisterStoreHolderOptions): Promise<StoreHolderHandle> {
  const runtime = ensureStoreRuntime(options);
  let preHome: MaintenanceMetadata | undefined;
  let preStore: MaintenanceMetadata | undefined;
  try {
    [preHome, preStore] = await Promise.all([
      activeFence(runtime.directory, runtime.uid),
      activeFence(runtime.storeDirectory, runtime.uid),
    ]);
  } catch (error) {
    throw new Error(`store coordination is unsafe: ${(error as Error).message}`);
  }
  if (preHome || preStore) throw new Error("store unavailable while maintenance is active");
  const pid = options.pid ?? process.pid;
  if (!validInteger(pid, true)) throw new Error("invalid store holder process id");
  const holderId = (options.randomId ?? randomUUID)();
  if (!SAFE_ID.test(holderId)) throw new Error("invalid store holder id");
  const now = options.now ?? Date.now;
  const metadata: StoreHolderMetadata = {
    protocol: STORE_COORDINATION_PROTOCOL,
    holderId,
    repoId: runtime.repoId,
    pid,
    processStartId: (options.processStartId ?? getProcessStartId)(pid) ?? null,
    createdAt: now(),
    command: normalizedCommand(options.command),
  };
  const artifact = path.join(runtime.holdersDirectory, `.admission-owner-${holderId}-${randomUUID()}.json`);
  try {
    await writeImmutableJson(artifact, metadata);
    await fs.link(artifact, holderPath(runtime, holderId));
  } finally {
    await fs.unlink(artifact).catch(() => undefined);
  }
  const published = await readPrivateJsonWithIdentity(holderPath(runtime, holderId), runtime.uid);
  const publishedMetadata = validateHolder(published.value, runtime.repoId);
  if (JSON.stringify(publishedMetadata) !== JSON.stringify(metadata)) {
    throw new Error("store holder ownership changed during publication");
  }
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releasePromise ??= releaseHolder(runtime, metadata, published.identity);
    return releasePromise;
  };
  try {
    const [postHome, postStore] = await Promise.all([
      activeFence(runtime.directory, runtime.uid),
      activeFence(runtime.storeDirectory, runtime.uid),
    ]);
    if (postHome || postStore) {
      await release();
      throw new Error("store unavailable because maintenance raced with startup");
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  return { metadata, runtime, release };
}

export async function acquireStoreMaintenance(options: StoreMaintenanceOptions): Promise<MaintenanceAcquisition> {
  const runtime = ensureStoreRuntime(options);
  try {
    if (await activeFence(runtime.directory, runtime.uid)) return blocked("home maintenance is active");
  } catch (error) {
    return blocked((error as Error).message);
  }
  const acquired = await acquireFence(runtime, runtime.storeDirectory, "store", runtime.repoId, options);
  if (!acquired.acquired) return acquired;
  try {
    if (await activeFence(runtime.directory, runtime.uid)) {
      await acquired.release();
      return blocked("home maintenance raced with store maintenance");
    }
  } catch (error) {
    await acquired.release().catch(() => undefined);
    return blocked((error as Error).message);
  }
  return acquired;
}

export async function acquireHomeMaintenance(options: MaintenanceOptions): Promise<MaintenanceAcquisition> {
  const runtime = ensureHomeRuntime(options);
  const acquired = await acquireFence(runtime, runtime.directory, "home", null, options);
  if (!acquired.acquired) return acquired;
  try {
    for (const repoId of await inventoryRuntimeStoreIds(runtime)) {
      const storeRuntime = ensureStoreRuntime({
        weaverHome: runtime.canonicalHome,
        tmpDir: options.tmpDir,
        uid: runtime.uid,
        repoId,
      });
      if (await activeFence(storeRuntime.storeDirectory, runtime.uid)) {
        await acquired.release();
        return blocked(`store maintenance is active for ${repoId}`);
      }
    }
  } catch (error) {
    await acquired.release().catch(() => undefined);
    return blocked((error as Error).message);
  }
  return acquired;
}

export async function isMaintenanceActive(directory: string, uid?: number): Promise<boolean> {
  const effectiveUid = uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (effectiveUid < 0) return true;
  try {
    return (await activeFence(directory, effectiveUid)) !== undefined;
  } catch {
    return true;
  }
}

async function holderIsCurrent(runtime: StoreRuntimePaths, expected: ActiveHolder): Promise<boolean> {
  try {
    const file = await readPrivateJsonWithIdentity(holderPath(runtime, expected.metadata.holderId), runtime.uid);
    const current = validateHolder(file.value, runtime.repoId);
    return (
      JSON.stringify(current) === JSON.stringify(expected.metadata) &&
      file.identity.dev === expected.identity.dev &&
      file.identity.ino === expected.identity.ino
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function activeHolders(maintenance: MaintenanceHandle, runtime: StoreRuntimePaths): Promise<ActiveHolder[]> {
  for (;;) {
    assertPrivateDirectory(runtime.holdersDirectory, runtime.uid);
    const names = await fs.readdir(runtime.holdersDirectory);
    const holderIds = new Set<string>();
    const releaseIds = new Set<string>();
    for (const name of names) {
      if (name.startsWith(HOLDER_RELEASE_PREFIX)) {
        const id = name.slice(HOLDER_RELEASE_PREFIX.length, -".json".length);
        if (!name.endsWith(".json") || !SAFE_ID.test(id)) throw new Error("malformed holder release filename");
        releaseIds.add(id);
        continue;
      }
      if (name.startsWith(HOLDER_PREFIX)) {
        const id = name.slice(HOLDER_PREFIX.length, -".json".length);
        if (!name.endsWith(".json") || !SAFE_ID.test(id)) throw new Error("malformed holder filename");
        holderIds.add(id);
      }
    }

    let retry = false;
    for (const id of releaseIds) {
      const releasePath = holderReleasePath(runtime, id);
      let holder: ActiveHolder | undefined;
      try {
        const file = await readPrivateJsonWithIdentity(holderPath(runtime, id), runtime.uid);
        holder = { identity: file.identity, metadata: validateHolder(file.value, runtime.repoId) };
        validateHolderRelease(await readPrivateJson(releasePath, runtime.uid), holder.metadata);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        try {
          validateHolderReleaseForRepo(await readPrivateJson(releasePath, runtime.uid), id, runtime.repoId);
        } catch (releaseError) {
          if (!isErrno(releaseError, "ENOENT")) throw releaseError;
          retry = true;
          break;
        }
      }
      if (!(await maintenance.revalidate())) throw new Error("maintenance fence ownership changed");
      if (holder) {
        await releaseHolder(runtime, holder.metadata, holder.identity);
      }
      await fs.unlink(releasePath).catch((error) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
      retry = true;
    }
    if (retry) continue;

    const active: ActiveHolder[] = [];
    for (const id of holderIds) {
      try {
        const file = await readPrivateJsonWithIdentity(holderPath(runtime, id), runtime.uid);
        active.push({ identity: file.identity, metadata: validateHolder(file.value, runtime.repoId) });
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          retry = true;
          break;
        }
        throw error;
      }
    }
    if (!retry) return active;
  }
}

export async function drainStoreHolders(
  maintenance: MaintenanceHandle,
  runtime: StoreRuntimePaths,
  options: DrainOptions = {},
): Promise<DrainResult> {
  if (!(await maintenance.revalidate())) return { ok: false, error: "maintenance fence ownership changed" };
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 50;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inspect = options.inspectProcess ?? inspectHolderProcess;
  const deadline = now() + timeoutMs;
  for (;;) {
    let holders: ActiveHolder[];
    try {
      holders = await activeHolders(maintenance, runtime);
    } catch (error) {
      return { ok: false, error: `unsafe store holder metadata: ${(error as Error).message}` };
    }
    if (!holders.length) return { ok: true };
    let waiting = false;
    for (const holder of holders) {
      const state = await Promise.resolve(inspect(holder.metadata)).catch(() => "indeterminate" as const);
      if (state === "absent" || state === "reused") {
        try {
          await releaseHolder(runtime, holder.metadata, holder.identity);
        } catch (error) {
          return { ok: false, error: `stale store holder could not be reclaimed: ${(error as Error).message}` };
        }
      } else if (state === "matching") {
        waiting ||= await holderIsCurrent(runtime, holder);
      } else {
        if (await holderIsCurrent(runtime, holder)) {
          return { ok: false, error: `store holder ${holder.metadata.holderId} has indeterminate process identity` };
        }
      }
    }
    if (!(await maintenance.revalidate())) return { ok: false, error: "maintenance fence ownership changed" };
    if (!waiting) continue;
    if (now() >= deadline) {
      try {
        if (!(await activeHolders(maintenance, runtime)).length) return { ok: true };
      } catch (error) {
        return { ok: false, error: `unsafe store holder metadata: ${(error as Error).message}` };
      }
      return { ok: false, error: "timed out waiting for store holders to close" };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export async function inventoryRuntimeStoreIds(home: HomeRuntimePaths): Promise<string[]> {
  assertPrivateDirectory(home.storesDirectory, home.uid);
  const entries = await fs.readdir(home.storesDirectory, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !/^s[A-Za-z0-9_-]{8}$/.test(entry.name)) {
      throw new Error("unsafe store runtime namespace");
    }
    ids.push(readStoreRuntimeRepoId(home, path.join(home.storesDirectory, entry.name)));
  }
  return [...new Set(ids)].sort();
}

export async function inventoryHomeStoreIds(home: HomeRuntimePaths): Promise<string[]> {
  const ids = new Set(await inventoryRuntimeStoreIds(home));
  try {
    const entries = await fs.readdir(home.canonicalHome, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".db")) continue;
      const repoId = entry.name.slice(0, -3);
      if (entry.isSymbolicLink() || !entry.isFile() || !SAFE_REPO_ID.test(repoId)) {
        throw new Error(`unsafe store file in Weaver home: ${entry.name}`);
      }
      const stat = await fs.lstat(path.join(home.canonicalHome, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe store file in Weaver home: ${entry.name}`);
      ids.add(repoId);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return [...ids].sort();
}

export function runtimeForHomeStore(
  home: HomeRuntimePaths,
  repoId: string,
  options: Pick<RuntimeScopeOptions, "tmpDir"> = {},
): StoreRuntimePaths {
  return ensureStoreRuntime({
    repoId,
    weaverHome: home.canonicalHome,
    uid: home.uid,
    tmpDir: options.tmpDir ?? path.dirname(path.dirname(home.directory)),
  });
}

export function runtimeFromHomeOptions(options: RuntimeScopeOptions): HomeRuntimePaths {
  return homeRuntimePaths(options);
}
