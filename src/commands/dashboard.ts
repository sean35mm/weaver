import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { flagBool, flagStr } from "../args.ts";
import type { Ctx } from "../context.ts";
import { isDashboardMaintenanceActive } from "../dashboard/maintenance.ts";
import { coordinateDashboardOwnership, type DashboardStop } from "../dashboard/ownership.ts";
import { ensureDashboardRuntime } from "../dashboard/runtime.ts";
import { startDashboard } from "../dashboard/server.ts";
import { claimsByLiveHolders, formatStatus, type StatusData } from "../render.ts";
import { DEFAULT_COMPLETED_SESSION_RECENT_MS } from "../store/reap.ts";
import { themeFromCtx } from "../terminal/color.ts";
import { CliError } from "../validate.ts";

interface SignalWaiter {
  promise: Promise<void>;
  close(): void;
}

function waitForSignal(): SignalWaiter {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  let resolve!: () => void;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const signal of signals) process.removeListener(signal, handler);
  };
  const handler = (): void => {
    close();
    resolve();
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  for (const signal of signals) process.on(signal, handler);
  return { promise, close };
}

export type DashboardOpenMode = "auto" | "browser" | "cmux";

export interface DashboardLauncherDeps {
  platform: NodeJS.Platform;
  socketExists(path: string): boolean;
  run(command: string, args: string[], cwd: string): { ok: boolean; stdout: string };
  runAsync(command: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }>;
  open(command: string, args: string[], cwd: string): void;
  sleep(ms: number): Promise<void>;
}

export interface DashboardLaunchHandle {
  kind: "browser" | "cmux";
  managed: boolean;
  surfaceId: string | null;
  focus(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CmuxBrowserSurface {
  id: string;
  ref: string;
  url: string;
  workspaceId: string;
}

const CMUX_OUTPUT_LIMIT = 512 * 1024;
const CMUX_ASYNC_COMMAND_TIMEOUT_MS = 1_000;
const CMUX_TREE_POLL_ATTEMPTS = 4;
const CMUX_TREE_POLL_INTERVAL_MS = 50;
const CMUX_CLOSE_ATTEMPTS = 3;
const CMUX_CLOSE_RETRY_MS = 50;

const DEFAULT_LAUNCHER_DEPS: DashboardLauncherDeps = {
  platform: process.platform,
  socketExists: fs.existsSync,
  run: (command, args, cwd) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: CMUX_OUTPUT_LIMIT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? "" };
  },
  runAsync: (command, args, cwd) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: CMUX_OUTPUT_LIMIT,
          shell: false,
          timeout: CMUX_ASYNC_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => resolve({ ok: !error, stdout: stdout ?? "" }),
      );
    }),
  open: (command, args, cwd) => {
    try {
      const child = spawn(command, args, { cwd, stdio: "ignore", detached: true });
      child.once("error", () => undefined);
      child.unref();
    } catch {
      // Best effort. The launch URL is always printed for manual use.
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCmuxBrowserSurfaces(raw: string, workspaceId: string): CmuxBrowserSurface[] | null {
  try {
    const root = asRecord(JSON.parse(raw));
    if (!root || !Array.isArray(root.windows)) return null;
    const surfaces: CmuxBrowserSurface[] = [];
    let foundWorkspace = false;
    for (const windowValue of root.windows) {
      const window = asRecord(windowValue);
      if (!window || !Array.isArray(window.workspaces)) continue;
      for (const workspaceValue of window.workspaces) {
        const workspace = asRecord(workspaceValue);
        if (!workspace || (workspace.id !== workspaceId && workspace.ref !== workspaceId)) continue;
        foundWorkspace = true;
        if (!Array.isArray(workspace.panes)) return null;
        for (const paneValue of workspace.panes) {
          const pane = asRecord(paneValue);
          if (!pane || !Array.isArray(pane.surfaces)) return null;
          for (const surfaceValue of pane.surfaces) {
            const surface = asRecord(surfaceValue);
            if (!surface || typeof surface.type !== "string") return null;
            if (
              surface.type === "browser" &&
              typeof surface.id === "string" &&
              typeof surface.ref === "string" &&
              typeof surface.url === "string"
            ) {
              surfaces.push({ id: surface.id, ref: surface.ref, url: surface.url, workspaceId: String(workspace.id) });
            } else if (surface.type === "browser") {
              return null;
            }
          }
        }
      }
    }
    return foundWorkspace ? surfaces : null;
  } catch {
    return null;
  }
}

export function findNewCmuxBrowserSurface(
  before: CmuxBrowserSurface[],
  after: CmuxBrowserSurface[],
  url: string,
  sourceSurfaceId?: string,
): CmuxBrowserSurface | null {
  const matches = findNewCmuxBrowserSurfaces(before, after, url, sourceSurfaceId);
  return matches.length === 1 ? matches[0]! : null;
}

/** Matches the stable URL portion cmux retains after the dashboard strips its capability fragment. */
export function matchesCmuxSurfaceUrlIdentity(surfaceUrl: string, launchUrl: string): boolean {
  try {
    const surface = new URL(surfaceUrl);
    const launch = new URL(launchUrl);
    const launchInstances = launch.searchParams.getAll("instance");
    const surfaceInstances = surface.searchParams.getAll("instance");
    return (
      launch.protocol === surface.protocol &&
      launch.hostname === surface.hostname &&
      launch.port === surface.port &&
      launch.pathname === surface.pathname &&
      launch.username === "" &&
      launch.password === "" &&
      surface.username === "" &&
      surface.password === "" &&
      launchInstances.length === 1 &&
      surfaceInstances.length === 1 &&
      /^[A-Za-z0-9_-]{22}$/.test(launchInstances[0]!) &&
      launch.search === `?instance=${launchInstances[0]}` &&
      surface.search === launch.search &&
      surfaceInstances[0] === launchInstances[0]
    );
  } catch {
    return false;
  }
}

function findNewCmuxBrowserSurfaces(
  before: CmuxBrowserSurface[],
  after: CmuxBrowserSurface[],
  url: string,
  sourceSurfaceId?: string,
): CmuxBrowserSurface[] {
  const existingIds = new Set(before.map((surface) => surface.id));
  return after.filter(
    (surface) =>
      !existingIds.has(surface.id) &&
      surface.id !== sourceSurfaceId &&
      surface.ref !== sourceSurfaceId &&
      matchesCmuxSurfaceUrlIdentity(surface.url, url),
  );
}

function inertHandle(kind: "browser" | "cmux", managed = false): DashboardLaunchHandle {
  return { kind, managed, surfaceId: null, focus: async () => false, close: async () => undefined };
}

type CmuxSurfaceResolution = { status: "present"; ref: string } | { status: "absent" } | { status: "unknown" };

function resolveCmuxSurface(
  owned: Pick<CmuxBrowserSurface, "id" | "url" | "workspaceId">,
  cwd: string,
  deps: DashboardLauncherDeps,
): CmuxSurfaceResolution {
  const snapshot = deps.run("cmux", ["--id-format", "both", "tree", "--all", "--json"], cwd);
  const surfaces = snapshot.ok ? parseCmuxBrowserSurfaces(snapshot.stdout, owned.workspaceId) : null;
  if (!surfaces) return { status: "unknown" };
  const matches = surfaces.filter(
    (surface) =>
      surface.id === owned.id &&
      surface.workspaceId === owned.workspaceId &&
      matchesCmuxSurfaceUrlIdentity(surface.url, owned.url),
  );
  if (matches.length === 0) return { status: "absent" };
  if (matches.length !== 1) return { status: "unknown" };
  return { status: "present", ref: matches[0]!.ref };
}

async function resolveCmuxSurfaceAsync(
  owned: Pick<CmuxBrowserSurface, "id" | "url" | "workspaceId">,
  cwd: string,
  deps: DashboardLauncherDeps,
): Promise<CmuxSurfaceResolution> {
  const snapshot = await deps.runAsync("cmux", ["--id-format", "both", "tree", "--all", "--json"], cwd);
  const surfaces = snapshot.ok ? parseCmuxBrowserSurfaces(snapshot.stdout, owned.workspaceId) : null;
  if (!surfaces) return { status: "unknown" };
  const matches = surfaces.filter(
    (surface) =>
      surface.id === owned.id &&
      surface.workspaceId === owned.workspaceId &&
      matchesCmuxSurfaceUrlIdentity(surface.url, owned.url),
  );
  if (matches.length === 0) return { status: "absent" };
  if (matches.length !== 1) return { status: "unknown" };
  return { status: "present", ref: matches[0]!.ref };
}

export function parseOpenMode(raw: string | undefined): DashboardOpenMode {
  const mode = raw ?? "auto";
  if (mode !== "auto" && mode !== "browser" && mode !== "cmux") {
    throw new CliError("--open expects auto, browser, or cmux");
  }
  return mode;
}

export async function launchDashboard(
  url: string,
  mode: DashboardOpenMode,
  env: Record<string, string | undefined>,
  cwd: string,
  deps: DashboardLauncherDeps = DEFAULT_LAUNCHER_DEPS,
): Promise<DashboardLaunchHandle> {
  if (mode === "browser") {
    const command = deps.platform === "darwin" ? "open" : "xdg-open";
    deps.open(command, [url], cwd);
    return inertHandle("browser");
  }

  const socket = env.CMUX_SOCKET_PATH ?? env.CMUX_SOCKET;
  const workspaceId = env.CMUX_WORKSPACE_ID;
  let before: CmuxBrowserSurface[] | null = null;
  try {
    const inCmux = Boolean(workspaceId && socket && deps.socketExists(socket));
    if (inCmux && deps.run("cmux", ["ping"], cwd).ok) {
      const snapshot = deps.run("cmux", ["--id-format", "both", "tree", "--all", "--json"], cwd);
      if (snapshot.ok) before = parseCmuxBrowserSurfaces(snapshot.stdout, workspaceId!);
    }
  } catch {
    before = null;
  }

  if (!before || !workspaceId) {
    const command = deps.platform === "darwin" ? "open" : "xdg-open";
    deps.open(command, [url], cwd);
    return inertHandle("browser");
  }

  let created = false;
  try {
    created = deps.run(
      "cmux",
      [
        "new-pane",
        "--type",
        "browser",
        "--direction",
        "right",
        "--workspace",
        workspaceId,
        "--url",
        url,
        "--focus",
        "false",
      ],
      cwd,
    ).ok;
  } catch {
    return inertHandle("cmux");
  }
  if (!created) return inertHandle("cmux");

  let owned: CmuxBrowserSurface | null = null;
  for (let attempt = 0; attempt < CMUX_TREE_POLL_ATTEMPTS; attempt++) {
    try {
      const snapshot = deps.run("cmux", ["--id-format", "both", "tree", "--all", "--json"], cwd);
      const after = snapshot.ok ? parseCmuxBrowserSurfaces(snapshot.stdout, workspaceId) : null;
      if (after) {
        const matches = findNewCmuxBrowserSurfaces(before, after, url, env.CMUX_SURFACE_ID);
        if (matches.length > 1) break;
        if (matches.length === 1) {
          owned = matches[0]!;
          break;
        }
      }
    } catch {
      // A later bounded poll may observe the surface once cmux updates its tree.
    }
    if (attempt + 1 < CMUX_TREE_POLL_ATTEMPTS) await deps.sleep(CMUX_TREE_POLL_INTERVAL_MS);
  }
  if (!owned) return inertHandle("cmux");
  const ownedIdentity = { id: owned.id, workspaceId: owned.workspaceId, url };

  let closed = false;
  let closing: Promise<void> | undefined;
  let focusing: Promise<boolean> | undefined;
  return {
    kind: "cmux",
    managed: true,
    surfaceId: owned.id,
    focus: async () => {
      if (closed) return false;
      if (focusing) return focusing;
      focusing = (async () => {
        try {
          if (closed) return false;
          const current = await resolveCmuxSurfaceAsync(ownedIdentity, cwd, deps);
          if (current.status !== "present") return false;
          const focused = await deps.runAsync(
            "cmux",
            ["focus-panel", "--panel", current.ref, "--workspace", ownedIdentity.workspaceId],
            cwd,
          );
          if (!focused.ok) return false;
          try {
            await deps.runAsync("cmux", ["browser", "--surface", current.ref, "focus-webview"], cwd);
          } catch {
            // cmux 0.64.22 can report internal_error after focus-panel has already selected the surface.
          }
          return true;
        } catch {
          return false;
        }
      })().finally(() => {
        focusing = undefined;
      });
      return focusing;
    },
    close: async () => {
      if (closed) return;
      if (closing) return closing;
      closing = (async () => {
        let closeRequested = false;
        for (let attempt = 0; attempt < CMUX_CLOSE_ATTEMPTS; attempt++) {
          try {
            const current = resolveCmuxSurface(ownedIdentity, cwd, deps);
            if (current.status === "absent") {
              closed = true;
              return;
            }
            if (current.status === "present" && !closeRequested) {
              closeRequested = deps.run(
                "cmux",
                ["close-surface", "--surface", current.ref, "--workspace", ownedIdentity.workspaceId],
                cwd,
              ).ok;
            }
          } catch {
            // A later bounded attempt may recover; never broaden beyond the exact owned surface.
          }
          if (attempt + 1 < CMUX_CLOSE_ATTEMPTS) await deps.sleep(CMUX_CLOSE_RETRY_MS);
        }
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}

export function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("port must be an integer between 0 and 65535");
  }
  return port;
}

export interface DashboardRunDeps {
  isMaintenanceActive: typeof isDashboardMaintenanceActive;
  coordinateOwnership: typeof coordinateDashboardOwnership;
  ensureRuntime: typeof ensureDashboardRuntime;
  startServer: typeof startDashboard;
  launch: typeof launchDashboard;
}

const DEFAULT_RUN_DEPS: DashboardRunDeps = {
  isMaintenanceActive: isDashboardMaintenanceActive,
  coordinateOwnership: coordinateDashboardOwnership,
  ensureRuntime: ensureDashboardRuntime,
  startServer: startDashboard,
  launch: launchDashboard,
};

export async function runDashboard(ctx: Ctx, deps: DashboardRunDeps = DEFAULT_RUN_DEPS): Promise<number> {
  const port = parsePort(flagStr(ctx.args, "port"));
  const openMode = parseOpenMode(flagStr(ctx.args, "open"));
  const theme = themeFromCtx(ctx);
  const ownerId = randomUUID();
  const runtime = deps.ensureRuntime({
    repoId: ctx.repo.repoId,
    ownerId,
    weaverHome: ctx.env.WEAVER_HOME,
  });
  let launch: DashboardLaunchHandle | undefined;
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined;
  if (await deps.isMaintenanceActive({ runtimeDirectory: runtime.directory })) {
    ctx.err("weaver: dashboard unavailable while store maintenance is active\n");
    return 1;
  }
  const ownership = await deps.coordinateOwnership({
    store: ctx.store,
    repoId: ctx.repo.repoId,
    scopeId: runtime.scopeId,
    runtimeDirectory: runtime.directory,
    ownerId,
    focus: () => launch?.focus() ?? false,
    onOwnershipLost: async () => {
      await server?.close();
      await launch?.close();
    },
  });

  if (await deps.isMaintenanceActive({ runtimeDirectory: runtime.directory })) {
    if (ownership.kind === "owner") await ownership.close();
    ctx.err("weaver: dashboard unavailable while store maintenance is active\n");
    return 1;
  }

  if (ownership.kind === "follower") {
    const launchUrl = ownership.control.launchUrl;
    ctx.out(`${theme.accent("scratchpads already running")} ${theme.dim("→")} ${theme.path(launchUrl)}\n`);
    if (port !== undefined && Number(new URL(launchUrl).port) !== port) {
      ctx.out(`${theme.dim(`requested --port ${port} ignored; the existing dashboard keeps its current port`)}\n`);
    }
    if (flagBool(ctx.args, "no-open")) return 0;
    if (openMode === "browser") {
      await launchDashboard(launchUrl, "browser", ctx.env, ctx.cwd);
    } else if (!(await ownership.focus())) {
      ctx.out(`${theme.dim("existing dashboard surface could not be focused; use the URL above")}\n`);
    }
    return 0;
  }

  const signals = waitForSignal();
  let stop: DashboardStop | { reason: "signal" };
  try {
    server = await deps.startServer({
      store: ctx.store,
      repoId: ctx.repo.repoId,
      port,
      sessionTtlMs: ctx.config.sessionTtlMs,
      actor: { kind: "human", sessionId: null, harness: null, provenance: "dashboard", worktreeId: null },
      caller: null,
      isOwner: ownership.isCurrent,
    });
    if (ownership.getState() === "shutting-down") {
      stop = await ownership.stopped;
      return stop.reason === "ownership-lost" ? 1 : 0;
    }
    launch = flagBool(ctx.args, "no-open")
      ? inertHandle("browser")
      : await deps.launch(server.launchUrl, openMode, ctx.env, ctx.cwd);
    if (ownership.getState() === "shutting-down") {
      stop = await ownership.stopped;
      return stop.reason === "ownership-lost" ? 1 : 0;
    }
    await ownership.ready(server.launchUrl);
    if (ownership.getState() === "shutting-down") {
      stop = await ownership.stopped;
      return stop.reason === "ownership-lost" ? 1 : 0;
    }
    ctx.out(
      `${theme.accent("weaver scratchpads")} ${theme.dim("→")} ${theme.path(server.launchUrl)}   ${theme.dim("(Ctrl-C to stop)")}\n`,
    );
    stop = await Promise.race([signals.promise.then(() => ({ reason: "signal" }) as const), ownership.stopped]);
  } finally {
    signals.close();
    try {
      await server?.close();
    } finally {
      try {
        await launch?.close();
      } finally {
        await ownership.close();
      }
    }
  }
  if (stop.reason === "ownership-lost") {
    ctx.err(`weaver: dashboard ownership lost: ${stop.error.message}\n`);
    return 1;
  }
  ctx.out(`\n${theme.success("✓ scratchpads stopped")}\n`);
  return 0;
}

export async function runWatch(ctx: Ctx): Promise<number> {
  const theme = themeFromCtx(ctx);
  const draw = (): void => {
    const now = Date.now();
    const sessions = ctx.store.listActiveSessions(now, ctx.config.sessionTtlMs);
    const data: StatusData = {
      sessions,
      completed: ctx.store.listRecentEndedSessions(5, now - DEFAULT_COMPLETED_SESSION_RECENT_MS),
      claims: claimsByLiveHolders(ctx.store.listActiveClaims(now), sessions),
      activity: ctx.store.listRecentActivity(12),
      notes: ctx.store.listNotes(8),
    };
    const empty =
      !data.sessions.length &&
      !data.completed.length &&
      !data.claims.length &&
      !data.activity.length &&
      !data.notes.length;
    const body = empty ? `${theme.dim("no activity")}\n` : formatStatus(data, now, ctx.store, theme);
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + cursor home
    process.stdout.write(
      `🧵 ${theme.accent("weaver watch")} ${theme.dim("—")} ${theme.dim(ctx.repo.repoId)}   ${theme.dim("(Ctrl-C to stop)")}\n\n${body}`,
    );
  };

  draw();
  const timer = setInterval(draw, 1000);
  const signals = waitForSignal();
  await signals.promise;
  signals.close();
  clearInterval(timer);
  process.stdout.write("\n");
  return 0;
}
