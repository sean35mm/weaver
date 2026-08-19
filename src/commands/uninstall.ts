import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { quiesceDashboard } from "../dashboard/maintenance.ts";
import { isStandaloneBinary } from "../env.ts";
import {
  acquireHomeMaintenance,
  drainStoreHolders,
  inventoryHomeStoreIds,
  type MaintenanceHandle,
  runtimeForHomeStore,
} from "../store/coordination.ts";
import { openDb } from "../store/db.ts";
import { weaverDir } from "../store/location.ts";
import { openStore } from "../store/open.ts";
import { canonicalRuntimePath, type HomeRuntimePaths } from "../store/runtime.ts";
import { hasEarlyV6DashboardLeaseSchema, inspectSchemaCompatibility, SCHEMA_VERSION } from "../store/schema.ts";

export interface TargetInspectionDeps {
  lstat(filePath: string): fs.Stats;
  realpath(filePath: string): string;
  uid: number | null;
}

const DEFAULT_TARGET_INSPECTION_DEPS: TargetInspectionDeps = {
  lstat: fs.lstatSync,
  realpath: fs.realpathSync.native,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
};

export interface PathIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  path: string;
}

export interface BinaryTarget {
  file: PathIdentity;
  parent: PathIdentity;
}

function targetDeps(overrides: Partial<TargetInspectionDeps> = {}): TargetInspectionDeps {
  return { ...DEFAULT_TARGET_INSPECTION_DEPS, ...overrides };
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function identity(filePath: string, canonicalPath: string, stat: fs.Stats): PathIdentity {
  return { path: filePath, canonicalPath, dev: stat.dev, ino: stat.ino };
}

function sameIdentity(actual: PathIdentity, expected: PathIdentity): boolean {
  return (
    actual.path === expected.path &&
    actual.canonicalPath === expected.canonicalPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

export function inspectUninstallHome(
  filePath: string,
  options: { allowMissing?: boolean; deps?: Partial<TargetInspectionDeps> } = {},
): PathIdentity | undefined {
  const deps = targetDeps(options.deps);
  if (!filePath.trim()) throw new Error("WEAVER_HOME must not be empty");
  const resolved = path.resolve(filePath);
  if (resolved === path.parse(resolved).root) throw new Error("refusing to use a filesystem root as WEAVER_HOME");
  let stat: fs.Stats;
  try {
    stat = deps.lstat(resolved);
  } catch (error) {
    if (isErrno(error, "ENOENT") && options.allowMissing) return undefined;
    if (isErrno(error, "ENOENT")) throw new Error(`WEAVER_HOME does not exist: ${resolved}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("WEAVER_HOME must be a non-symlink directory");
  if (deps.uid !== null && stat.uid !== deps.uid) throw new Error("WEAVER_HOME is not owned by the current user");
  if ((stat.mode & 0o022) !== 0) throw new Error("WEAVER_HOME must not be group- or world-writable");
  const canonicalPath = deps.realpath(resolved);
  if (canonicalPath === path.parse(canonicalPath).root)
    throw new Error("refusing to use a filesystem root as WEAVER_HOME");
  const result = identity(resolved, canonicalPath, stat);
  const repeated = deps.lstat(resolved);
  if (!sameIdentity(identity(resolved, deps.realpath(resolved), repeated), result)) {
    throw new Error("WEAVER_HOME changed during inspection");
  }
  return result;
}

export function revalidateUninstallHome(expected: PathIdentity, deps: Partial<TargetInspectionDeps> = {}): void {
  const current = inspectUninstallHome(expected.path, { deps });
  if (!current || !sameIdentity(current, expected)) throw new Error("WEAVER_HOME changed during uninstall");
}

function inspectRealDirectory(filePath: string, deps: TargetInspectionDeps): PathIdentity {
  const resolved = path.resolve(filePath);
  const stat = deps.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("binary parent must be a real directory");
  const canonicalPath = deps.realpath(resolved);
  return identity(resolved, canonicalPath, stat);
}

export function inspectUninstallBinary(filePath: string, overrides: Partial<TargetInspectionDeps> = {}): BinaryTarget {
  const deps = targetDeps(overrides);
  const resolved = path.resolve(filePath);
  const parent = inspectRealDirectory(path.dirname(resolved), deps);
  const stat = deps.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("installed binary must be a regular non-symlink file");
  const canonicalPath = deps.realpath(resolved);
  if (canonicalPath !== path.join(parent.canonicalPath, path.basename(resolved))) {
    throw new Error("installed binary path must not end in a symlink");
  }
  const file = identity(resolved, canonicalPath, stat);
  const repeated = deps.lstat(resolved);
  if (!sameIdentity(identity(resolved, deps.realpath(resolved), repeated), file)) {
    throw new Error("installed binary changed during inspection");
  }
  return { file, parent };
}

export function revalidateUninstallBinary(expected: BinaryTarget, deps: Partial<TargetInspectionDeps> = {}): void {
  const current = inspectUninstallBinary(expected.file.path, deps);
  if (!sameIdentity(current.file, expected.file) || !sameIdentity(current.parent, expected.parent)) {
    throw new Error("installed binary or its parent changed during uninstall");
  }
}

function inspectStoreTarget(
  filePath: string,
  canonicalHome: string,
  overrides: Partial<TargetInspectionDeps> = {},
): PathIdentity {
  const deps = targetDeps(overrides);
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== canonicalHome) throw new Error(`store path escapes Weaver home: ${filePath}`);
  const stat = deps.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe store file: ${filePath}`);
  const canonicalPath = deps.realpath(resolved);
  const relative = path.relative(canonicalHome, canonicalPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`store path escapes Weaver home: ${filePath}`);
  return identity(resolved, canonicalPath, stat);
}

function revalidateStoreTarget(
  expected: PathIdentity,
  canonicalHome: string,
  deps: Partial<TargetInspectionDeps> = {},
): void {
  const current = inspectStoreTarget(expected.path, canonicalHome, deps);
  if (!sameIdentity(current, expected)) throw new Error(`store file changed during inspection: ${expected.path}`);
}

export interface UninstallDataSafetyDeps {
  acquireMaintenance: typeof acquireHomeMaintenance;
  drainHolders: typeof drainStoreHolders;
  inventory: typeof inventoryHomeStoreIds;
  openStore: typeof openStore;
  quiesce: typeof quiesceDashboard;
  runtimeForStore: typeof runtimeForHomeStore;
  openDb: typeof openDb;
  targetInspection: Partial<TargetInspectionDeps>;
}

export interface PreparedUninstallDataRemoval extends MaintenanceHandle {
  dataTargets: PathIdentity[];
}

const DEFAULT_DATA_SAFETY_DEPS: UninstallDataSafetyDeps = {
  acquireMaintenance: acquireHomeMaintenance,
  drainHolders: drainStoreHolders,
  inventory: inventoryHomeStoreIds,
  openStore,
  openDb,
  quiesce: quiesceDashboard,
  runtimeForStore: runtimeForHomeStore,
  targetInspection: {},
};

export async function prepareUninstallDataRemoval(
  ctx: Ctx,
  dir: string,
  dependencyOverrides: Partial<UninstallDataSafetyDeps> = {},
  expectedHome?: PathIdentity,
): Promise<PreparedUninstallDataRemoval | undefined> {
  const deps = { ...DEFAULT_DATA_SAFETY_DEPS, ...dependencyOverrides };
  let homeTarget: PathIdentity;
  try {
    homeTarget = expectedHome ?? inspectUninstallHome(dir, { deps: deps.targetInspection })!;
    revalidateUninstallHome(homeTarget, deps.targetInspection);
  } catch (error) {
    ctx.err(`weaver: uninstall blocked before deletion: ${(error as Error).message}\n`);
    return undefined;
  }
  let maintenance: Awaited<ReturnType<typeof acquireHomeMaintenance>>;
  try {
    maintenance = await deps.acquireMaintenance({ weaverHome: homeTarget.canonicalPath, reason: "uninstall" });
  } catch (error) {
    ctx.err(`weaver: uninstall blocked by unsafe home maintenance: ${(error as Error).message}\n`);
    return undefined;
  }
  if (!maintenance.acquired) {
    ctx.err(
      `weaver: uninstall blocked by active or unsafe home maintenance${maintenance.error ? `: ${maintenance.error}` : ""}\n`,
    );
    return undefined;
  }
  const home = maintenance.runtime as HomeRuntimePaths;
  try {
    revalidateUninstallHome(homeTarget, deps.targetInspection);
    if (home.canonicalHome !== homeTarget.canonicalPath)
      throw new Error("home maintenance resolved a different WEAVER_HOME");
    let previousInventory: string[] | undefined;
    const inspectedStores = new Map<string, PathIdentity>();
    for (;;) {
      if (!(await maintenance.revalidate())) throw new Error("home maintenance fence ownership changed");
      revalidateUninstallHome(homeTarget, deps.targetInspection);
      const stores = await deps.inventory(home);
      for (const repoId of stores) {
        const runtime = deps.runtimeForStore(home, repoId);
        const dbPath = path.join(home.canonicalHome, `${repoId}.db`);
        let store: Awaited<ReturnType<typeof openStore>> | undefined;
        try {
          let storeTarget: PathIdentity;
          try {
            storeTarget = inspectStoreTarget(dbPath, home.canonicalHome, deps.targetInspection);
          } catch (error) {
            if (isErrno(error, "ENOENT")) {
              const drained = await deps.drainHolders(maintenance, runtime);
              if (!drained.ok) throw new Error(`${repoId}: ${drained.error}`);
              continue;
            }
            throw error;
          }

          const raw = await deps.openDb(dbPath, { readOnly: true });
          let version: number | undefined;
          let earlyV6Lease = false;
          try {
            const inspection = inspectSchemaCompatibility(raw);
            version = inspection.version;
            if (
              version === undefined ||
              version < 1 ||
              (!inspection.tables.has("sessions") && !inspection.tables.has("notes"))
            ) {
              throw new Error(`not a recognized Weaver store: ${dbPath}`);
            }
            earlyV6Lease =
              version === SCHEMA_VERSION &&
              inspection.tables.has("dashboard_leases") &&
              hasEarlyV6DashboardLeaseSchema(raw);
          } finally {
            raw.close();
          }
          revalidateStoreTarget(storeTarget, home.canonicalHome, deps.targetInspection);

          if (version < SCHEMA_VERSION || earlyV6Lease) {
            store = await deps.openStore(dbPath);
          } else {
            store = await deps.openStore(dbPath, { readOnly: true, migrate: false });
          }
          revalidateStoreTarget(storeTarget, home.canonicalHome, deps.targetInspection);
          let quiescence = await deps.quiesce({
            store,
            repoId,
            scopeId: runtime.storeScopeId,
            runtimeDirectory: runtime.storeDirectory,
          });
          if (
            !quiescence.ok &&
            quiescence.error === "dashboard owner did not accept shutdown" &&
            version === SCHEMA_VERSION &&
            !earlyV6Lease
          ) {
            // A dead current-version owner may require deleting its exact stale lease.
            // Retry writable only after the read-only validation and quiescence attempt.
            store.close();
            store = undefined;
            revalidateStoreTarget(storeTarget, home.canonicalHome, deps.targetInspection);
            store = await deps.openStore(dbPath, { migrate: false });
            quiescence = await deps.quiesce({
              store,
              repoId,
              scopeId: runtime.storeScopeId,
              runtimeDirectory: runtime.storeDirectory,
            });
          }
          if (!quiescence.ok) throw new Error(quiescence.error);
          revalidateStoreTarget(storeTarget, home.canonicalHome, deps.targetInspection);
          inspectedStores.set(repoId, storeTarget);
        } finally {
          store?.close();
        }
        const drained = await deps.drainHolders(maintenance, runtime);
        if (!drained.ok) throw new Error(`${repoId}: ${drained.error}`);
      }

      const rescanned = await deps.inventory(home);
      if (previousInventory && JSON.stringify(previousInventory) === JSON.stringify(rescanned)) {
        // A pre-fence holder may have created a DB for an already-known runtime while draining.
        // Reaching the same inventory after a complete second pass proves that DB was inspected too.
        if (!(await maintenance.revalidate())) throw new Error("home maintenance fence ownership changed");
        revalidateUninstallHome(homeTarget, deps.targetInspection);
        const dataTargets: PathIdentity[] = [];
        for (const repoId of rescanned) {
          const inspected = inspectedStores.get(repoId);
          if (!inspected) continue;
          revalidateStoreTarget(inspected, home.canonicalHome, deps.targetInspection);
          dataTargets.push(inspected);
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            try {
              dataTargets.push(
                inspectStoreTarget(`${inspected.path}${suffix}`, home.canonicalHome, deps.targetInspection),
              );
            } catch (error) {
              if (!isErrno(error, "ENOENT")) throw error;
            }
          }
        }
        return Object.assign(maintenance, { dataTargets });
      }
      previousInventory = rescanned;
    }
  } catch (error) {
    ctx.err(`weaver: uninstall blocked before deletion: ${(error as Error).message}\n`);
    await maintenance.release().catch(() => undefined);
    return undefined;
  }
}

function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      const answer = chunk.toString().trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

export function removeInstallFiles(
  ctx: Pick<Ctx, "out" | "err">,
  dir: string,
  bin: string,
  keepData: boolean,
  remove: typeof fs.rmSync = fs.rmSync,
  safety: {
    binary?: BinaryTarget;
    dataTargets?: PathIdentity[];
    defaultHome?: string;
    home?: PathIdentity;
    recursiveHome?: boolean;
    targetInspection?: Partial<TargetInspectionDeps>;
  } = {},
): number {
  if (!keepData) {
    ctx.out(`! deleting ${dir} permanently removes all local authored coordination data.\n`);
    try {
      if (!safety.home) throw new Error("missing validated WEAVER_HOME identity");
      if (!safety.binary) throw new Error("missing validated installed binary identity");
      revalidateUninstallHome(safety.home, safety.targetInspection);
      if (canonicalRuntimePath(dir) !== safety.home.canonicalPath) {
        throw new Error("removal path is not the validated WEAVER_HOME");
      }
      if (safety.recursiveHome) {
        const canonicalDefault = canonicalRuntimePath(safety.defaultHome ?? path.join(os.homedir(), ".weaver"));
        if (safety.home.canonicalPath !== canonicalDefault) {
          throw new Error("recursive deletion is only allowed for the default ~/.weaver directory");
        }
        for (const target of safety.dataTargets ?? []) {
          revalidateStoreTarget(target, safety.home.canonicalPath, safety.targetInspection);
        }
        revalidateUninstallHome(safety.home, safety.targetInspection);
        revalidateUninstallBinary(safety.binary, safety.targetInspection);
        remove(dir, { recursive: true, force: true });
        ctx.out(`✓ removed ${dir}\n`);
      } else {
        const targets = safety.dataTargets ?? [];
        for (const target of targets) {
          revalidateStoreTarget(target, safety.home.canonicalPath, safety.targetInspection);
          if (!/^[A-Za-z0-9_-]{1,256}\.db(?:-wal|-shm|-journal)?$/.test(path.basename(target.path))) {
            throw new Error(`refusing unknown Weaver data filename: ${target.path}`);
          }
        }
        revalidateUninstallHome(safety.home, safety.targetInspection);
        revalidateUninstallBinary(safety.binary, safety.targetInspection);
        for (const target of targets) {
          revalidateUninstallHome(safety.home, safety.targetInspection);
          revalidateStoreTarget(target, safety.home.canonicalPath, safety.targetInspection);
          remove(target.path, { force: true });
        }
        ctx.out(
          `✓ removed ${targets.length} validated Weaver data file${targets.length === 1 ? "" : "s"} from ${dir}; left the directory and unrelated files intact\n`,
        );
      }
    } catch (e) {
      ctx.err(`weaver: couldn't remove ${dir}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  try {
    if (!safety.binary) throw new Error("missing validated installed binary identity");
    revalidateUninstallBinary(safety.binary, safety.targetInspection);
    remove(bin, { force: true });
    ctx.out(`✓ removed ${bin}\n`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const hint = code === "EACCES" || code === "EPERM" ? ` (try: sudo rm ${bin})` : "";
    ctx.err(
      `weaver: couldn't remove the binary${hint}: ${(e as Error).message}. Verify the target and remove it manually.\n`,
    );
    return 1;
  }
  return 0;
}

export interface UninstallRunDeps {
  dataSafety?: Partial<UninstallDataSafetyDeps>;
  execPath?: string;
  remove?: typeof fs.rmSync;
  targetInspection?: Partial<TargetInspectionDeps>;
}

export async function run(ctx: Ctx, deps: UninstallRunDeps = {}): Promise<number> {
  const bin = deps.execPath ?? process.execPath;
  if (!isStandaloneBinary(bin)) {
    ctx.err("weaver: `uninstall` only applies to the standalone (curl-installed) binary.\n");
    ctx.err("  You're running from source or an npm link — remove that manually (e.g. `npm rm -g`),\n");
    ctx.err(`  and remove ${ctx.env.WEAVER_HOME ?? weaverDir()} if you also want to clear the data.\n`);
    return 1;
  }

  const keepData = flagBool(ctx.args, "keep-data");
  const dir = ctx.env.WEAVER_HOME ?? weaverDir();

  if (!flagBool(ctx.args, "yes")) {
    if (!process.stdin.isTTY) {
      ctx.err("weaver: refusing to uninstall without confirmation — re-run with --yes.\n");
      return 1;
    }
    const what = keepData
      ? "the weaver binary"
      : `the weaver binary and ${dir} (includes all authored scratchpads, revision history, and Repository Facts)`;
    if (!(await confirm(`Remove ${what}? [y/N] `))) {
      ctx.out("aborted\n");
      return 0;
    }
  }

  let binaryTarget: BinaryTarget;
  try {
    binaryTarget = inspectUninstallBinary(bin, deps.targetInspection);
  } catch (error) {
    ctx.err(
      `weaver: refusing unsafe installed binary target: ${(error as Error).message}. Verify ${bin} and remove it manually.\n`,
    );
    return 1;
  }

  let maintenance: PreparedUninstallDataRemoval | undefined;
  let homeTarget: PathIdentity | undefined;
  if (!keepData) {
    try {
      homeTarget = inspectUninstallHome(dir, {
        allowMissing: ctx.env.WEAVER_HOME === undefined,
        deps: deps.targetInspection,
      });
    } catch (error) {
      ctx.err(`weaver: refusing unsafe WEAVER_HOME: ${(error as Error).message}\n`);
      return 1;
    }
    if (homeTarget) {
      const established = await prepareUninstallDataRemoval(
        ctx,
        dir,
        { ...deps.dataSafety, targetInspection: deps.targetInspection ?? {} },
        homeTarget,
      );
      if (!established) return 1;
      maintenance = established;
    }
  }
  let result: number;
  try {
    if (maintenance && !(await maintenance.revalidate())) {
      ctx.err("weaver: uninstall blocked before deletion: home maintenance fence ownership changed\n");
      return 1;
    }
    const removalDirectory = maintenance ? (maintenance.runtime as HomeRuntimePaths).canonicalHome : dir;
    result = removeInstallFiles(ctx, removalDirectory, bin, keepData || !homeTarget, deps.remove, {
      binary: binaryTarget,
      dataTargets: maintenance?.dataTargets,
      defaultHome: path.join(os.homedir(), ".weaver"),
      home: homeTarget,
      recursiveHome:
        ctx.env.WEAVER_HOME === undefined &&
        homeTarget !== undefined &&
        homeTarget.canonicalPath === canonicalRuntimePath(path.join(os.homedir(), ".weaver")),
      targetInspection: deps.targetInspection,
    });
  } finally {
    await maintenance?.release().catch(() => undefined);
  }

  if (result === 0) {
    ctx.out("\nweaver uninstalled. Any `weaver` blocks left in project or global instruction files are\n");
    ctx.out("self-disabling; run `weaver deinit` or `weaver deinit --global` beforehand if you want them gone.\n");
  }
  return result;
}
