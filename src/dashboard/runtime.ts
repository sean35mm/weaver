import { createHash } from "node:crypto";
import path from "node:path";
import { ensureStoreRuntime, storeRuntimePaths } from "../store/runtime.ts";

export interface DashboardRuntimePathOptions {
  repoId: string;
  ownerId: string;
  weaverHome?: string;
  defaultWeaverHome?: string;
  tmpDir?: string;
  uid?: number | null;
}

export interface DashboardRuntimePaths {
  scopeId: string;
  directory: string;
  socketPath: string;
}

function shortHash(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 20);
}

export function dashboardOwnerSocketPath(directory: string, scopeId: string, ownerId: string): string {
  if (!scopeId || !ownerId) throw new Error("dashboard scope and owner identities must not be empty");
  const socketPath = path.join(directory, `c-${shortHash(scopeId, ownerId).slice(0, 12)}.sock`);
  if (path.dirname(path.resolve(socketPath)) !== path.resolve(directory)) {
    throw new Error("dashboard control socket escaped its private runtime directory");
  }
  return socketPath;
}

/** Derive a stable user/store scope and an immutable owner-specific socket path. */
export function dashboardRuntimePaths(options: DashboardRuntimePathOptions): DashboardRuntimePaths {
  const runtime = storeRuntimePaths(options);
  const scopeId = runtime.storeScopeId;
  const directory = runtime.storeDirectory;
  return {
    scopeId,
    directory,
    socketPath: dashboardOwnerSocketPath(directory, scopeId, options.ownerId),
  };
}

/** Create and verify both uid and namespace directories without following a final symlink. */
export function ensureDashboardRuntime(options: DashboardRuntimePathOptions): DashboardRuntimePaths {
  ensureStoreRuntime(options);
  return dashboardRuntimePaths(options);
}
