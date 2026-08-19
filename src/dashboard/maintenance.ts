import fs from "node:fs/promises";
import type { MaintenanceAcquisition, MaintenanceHandle, StoreMaintenanceOptions } from "../store/coordination.ts";
import { acquireStoreMaintenance, isMaintenanceActive, STORE_COORDINATION_PROTOCOL } from "../store/coordination.ts";
import type { DashboardLeaseRow, Store } from "../store/store.ts";
import type { DashboardControlResponse } from "./control.ts";
import { DEFAULT_CONTROL_TIMEOUT_MS, requestDashboardControl } from "./control.ts";
import { dashboardOwnerSocketPath } from "./runtime.ts";

export const DASHBOARD_MAINTENANCE_PROTOCOL = STORE_COORDINATION_PROTOCOL;
export type DashboardMaintenanceOptions = StoreMaintenanceOptions;
export type DashboardMaintenanceHandle = MaintenanceHandle;
export type DashboardMaintenanceAcquisition = MaintenanceAcquisition;

export interface DashboardMaintenanceCheckOptions {
  runtimeDirectory: string;
}

export type DashboardQuiescenceStore = Pick<Store, "getDashboardLease" | "releaseDashboardLease">;

export interface DashboardQuiescenceOptions {
  store: DashboardQuiescenceStore;
  repoId: string;
  scopeId: string;
  runtimeDirectory: string;
  timeoutMs?: number;
  pollMs?: number;
  controlTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean | undefined | Promise<boolean | undefined>;
  requestControl?: typeof requestDashboardControl;
}

export type DashboardQuiescenceResult = { ok: true } | { ok: false; error: string };

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function defaultIsProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "ESRCH") ? false : undefined;
  }
}

function sameLeaseOwner(current: DashboardLeaseRow | undefined, expected: DashboardLeaseRow): boolean {
  return (
    current?.scopeId === expected.scopeId &&
    current.ownerId === expected.ownerId &&
    current.ownerPid === expected.ownerPid
  );
}

async function socketState(socketPath: string): Promise<"absent" | "socket" | "unsafe"> {
  try {
    const stat = await fs.lstat(socketPath);
    return stat.isSocket() && !stat.isSymbolicLink() ? "socket" : "unsafe";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "absent";
    return "unsafe";
  }
}

async function processLiveness(
  pid: number,
  isProcessAlive: (pid: number) => boolean | undefined | Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  try {
    return await isProcessAlive(pid);
  } catch {
    return undefined;
  }
}

function acceptedShutdown(response: DashboardControlResponse, repoId: string, ownerId: string): boolean {
  return response.ok && response.repoId === repoId && response.ownerId === ownerId;
}

async function recoverDeadDashboardOwner(
  options: DashboardQuiescenceOptions,
  lease: DashboardLeaseRow,
  socketPath: string,
): Promise<boolean> {
  let current: DashboardLeaseRow | undefined;
  try {
    current = options.store.getDashboardLease(options.scopeId);
  } catch {
    return false;
  }
  if (!sameLeaseOwner(current, lease)) return current === undefined;
  try {
    if (!options.store.releaseDashboardLease(options.scopeId, lease.ownerId)) return false;
    const state = await socketState(socketPath);
    if (state === "unsafe") return false;
    if (state === "socket") await fs.unlink(socketPath);
    return true;
  } catch {
    return false;
  }
}

/** Ask the exact dashboard owner to stop, then prove its lease and private endpoint are gone. */
export async function quiesceDashboard(options: DashboardQuiescenceOptions): Promise<DashboardQuiescenceResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 50;
  const controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const requestControl = options.requestControl ?? requestDashboardControl;
  let lease: DashboardLeaseRow | undefined;
  try {
    lease = options.store.getDashboardLease(options.scopeId);
  } catch {
    return { ok: false, error: "dashboard lease could not be inspected" };
  }
  if (!lease) return { ok: true };
  if (lease.scopeId !== options.scopeId || !lease.ownerId || !validInteger(lease.ownerPid) || lease.ownerPid === 0) {
    return { ok: false, error: "dashboard lease is malformed" };
  }

  let socketPath: string;
  try {
    socketPath = dashboardOwnerSocketPath(options.runtimeDirectory, options.scopeId, lease.ownerId);
  } catch {
    return { ok: false, error: "dashboard lease is malformed" };
  }

  try {
    const response = await requestControl({
      socketPath,
      repoId: options.repoId,
      ownerId: lease.ownerId,
      op: "shutdown",
      timeoutMs: controlTimeoutMs,
    });
    if (!acceptedShutdown(response, options.repoId, lease.ownerId)) {
      return { ok: false, error: "dashboard owner rejected shutdown" };
    }
  } catch {
    const alive = await processLiveness(lease.ownerPid, isProcessAlive);
    if (alive !== false || !(await recoverDeadDashboardOwner(options, lease, socketPath))) {
      return { ok: false, error: "dashboard owner did not accept shutdown" };
    }
  }

  const deadline = now() + timeoutMs;
  while (true) {
    let current: DashboardLeaseRow | undefined;
    try {
      current = options.store.getDashboardLease(options.scopeId);
    } catch {
      return { ok: false, error: "dashboard lease could not be inspected" };
    }
    if (current && !sameLeaseOwner(current, lease)) {
      return { ok: false, error: "dashboard ownership changed during maintenance" };
    }

    const [socket, alive] = await Promise.all([
      socketState(socketPath),
      processLiveness(lease.ownerPid, isProcessAlive),
    ]);
    if (socket === "unsafe") return { ok: false, error: "dashboard control endpoint is unsafe" };
    if (!current && socket === "absent") return { ok: true };
    if (!current && alive === false) {
      try {
        await fs.unlink(socketPath);
        return { ok: true };
      } catch {
        return { ok: false, error: "dead dashboard control endpoint could not be removed safely" };
      }
    }
    if (current && alive === false) {
      if (!(await recoverDeadDashboardOwner(options, lease, socketPath))) {
        return { ok: false, error: "dead dashboard owner could not be recovered safely" };
      }
      continue;
    }
    if (now() >= deadline) return { ok: false, error: "dashboard shutdown timed out" };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** Dashboard callers use the same generalized per-store fence as every destructive command. */
export function acquireDashboardMaintenance(
  options: DashboardMaintenanceOptions,
): Promise<DashboardMaintenanceAcquisition> {
  return acquireStoreMaintenance(options);
}

/** Fail closed when startup cannot prove that the generalized store fence is absent. */
export function isDashboardMaintenanceActive(options: DashboardMaintenanceCheckOptions): Promise<boolean> {
  return isMaintenanceActive(options.runtimeDirectory);
}
