import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  DASHBOARD_CONTROL_PROTOCOL,
  requestDashboardControl,
  startDashboardControlServer,
  validateFailedDashboardControlResponse,
  validateReadyDashboardControlResponse,
} from "../src/dashboard/control.ts";
import { dashboardOwnerSocketPath, dashboardRuntimePaths, ensureDashboardRuntime } from "../src/dashboard/runtime.ts";

const temporaryDirectories: string[] = [];
const INSTANCE_MARKER = "AAAAAAAAAAAAAAAAAAAAAA";

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dashboard-control-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function rawRequest(socketPath: string, body: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(body));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("runtime derives stable uid/store scope and immutable owner-private socket paths", () => {
  const tmpDir = temporaryDirectory();
  const homeA = path.join(tmpDir, "home-a", "missing");
  const a = dashboardRuntimePaths({ repoId: "repo", ownerId: "owner-a", weaverHome: homeA, tmpDir, uid: 501 });
  const sameScope = dashboardRuntimePaths({
    repoId: "repo",
    ownerId: "owner-b",
    weaverHome: path.join(tmpDir, "home-a", ".", "missing"),
    tmpDir,
    uid: 501,
  });
  const otherUid = dashboardRuntimePaths({ repoId: "repo", ownerId: "owner-a", weaverHome: homeA, tmpDir, uid: 502 });

  assert.equal(a.scopeId, sameScope.scopeId);
  assert.equal(a.directory, sameScope.directory);
  assert.notEqual(a.socketPath, sameScope.socketPath);
  assert.notEqual(a.scopeId, otherUid.scopeId);
  assert.equal(path.dirname(a.socketPath), a.directory);
  assert.equal(a.socketPath.includes("owner-a"), false);
  assert.ok(a.socketPath.length <= tmpDir.length + 60, `socket path should add little overhead: ${a.socketPath}`);

  const runtime = ensureDashboardRuntime({
    repoId: "repo",
    ownerId: "owner-a",
    weaverHome: homeA,
    tmpDir,
    uid: process.platform === "win32" ? null : process.getuid?.(),
  });
  const stat = fs.lstatSync(runtime.directory);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
});

test("owner socket derivation never accepts empty identity or leaves the runtime directory", () => {
  const directory = temporaryDirectory();
  assert.throws(() => dashboardOwnerSocketPath(directory, "scope", ""), /must not be empty/);
  const socketPath = dashboardOwnerSocketPath(directory, "../scope", "../../owner");
  assert.equal(path.dirname(socketPath), directory);
});

test("runtime rejects a symlink at the namespace directory", () => {
  const tmpDir = temporaryDirectory();
  const options = { repoId: "repo", ownerId: "owner", weaverHome: path.join(tmpDir, "home"), tmpDir };
  const paths = dashboardRuntimePaths(options);
  fs.mkdirSync(path.dirname(paths.directory), { recursive: true });
  fs.symlinkSync(tmpDir, paths.directory, "dir");
  assert.throws(() => ensureDashboardRuntime(options), /not a directory/);
});

test("ready and failure control response validators enforce semantic contracts", () => {
  const base = { protocol: DASHBOARD_CONTROL_PROTOCOL, repoId: "repo", ownerId: "owner" } as const;
  assert.equal(
    validateReadyDashboardControlResponse(
      {
        ...base,
        state: "ready",
        ok: true,
        launchUrl: `http://127.0.0.1:1234/?instance=${INSTANCE_MARKER}#cap=cap`,
      },
      "cap",
    ),
    true,
  );
  assert.equal(
    validateReadyDashboardControlResponse({
      ...base,
      state: "ready",
      ok: true,
      launchUrl: `http://[::1]/?instance=${INSTANCE_MARKER}#cap=cap`,
    }),
    true,
  );
  for (const launchUrl of [
    "",
    `https://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=cap`,
    `http://example.com/?instance=${INSTANCE_MARKER}#cap=cap`,
    `http://user@localhost/?instance=${INSTANCE_MARKER}#cap=cap`,
    `http://localhost/path?instance=${INSTANCE_MARKER}#cap=cap`,
    "http://localhost/#cap=cap",
    "http://localhost/?instance=short#cap=cap",
    `http://localhost/?instance=${INSTANCE_MARKER}&extra=value#cap=cap`,
    `http://localhost/?instance=${INSTANCE_MARKER}&instance=${INSTANCE_MARKER}#cap=cap`,
    `http://localhost/?instance=${INSTANCE_MARKER}#wrong=cap`,
    `http://localhost/?instance=${INSTANCE_MARKER}#cap=wrong`,
  ]) {
    assert.equal(validateReadyDashboardControlResponse({ ...base, state: "ready", ok: true, launchUrl }, "cap"), false);
  }
  assert.equal(
    validateReadyDashboardControlResponse(
      {
        ...base,
        state: "ready",
        ok: true,
        launchUrl: `http://[::1]/?instance=${INSTANCE_MARKER}#cap=cap`,
        error: "bad",
      },
      "cap",
    ),
    false,
  );
  assert.equal(validateFailedDashboardControlResponse({ ...base, state: "starting", ok: false, error: "wait" }), true);
  assert.equal(
    validateFailedDashboardControlResponse({
      ...base,
      state: "starting",
      ok: false,
      error: "wait",
      launchUrl: "http://x",
    }),
    false,
  );
  assert.equal(validateFailedDashboardControlResponse({ ...base, state: "starting", ok: false }), false);
});

test("control client rejects semantically invalid failure responses", async () => {
  const socketPath = path.join(temporaryDirectory(), "invalid.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          protocol: DASHBOARD_CONTROL_PROTOCOL,
          repoId: "repo",
          ownerId: "owner",
          state: "starting",
          ok: false,
          launchUrl: `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=cap`,
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      requestDashboardControl({ socketPath, repoId: "repo", ownerId: "owner", op: "ping" }),
      /semantically invalid response/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("private control socket authenticates identity and exposes launch URL only in ready responses", async () => {
  const directory = temporaryDirectory();
  const socketPath = path.join(directory, "control.sock");
  const server = await startDashboardControlServer({
    socketPath,
    repoId: "repo-a",
    ownerId: "owner-a",
    getState: () => "ready",
    getLaunchUrl: () => `http://127.0.0.1:1234/?instance=${INSTANCE_MARKER}#cap=capability`,
  });
  try {
    if (process.platform !== "win32") assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const response = await requestDashboardControl({ socketPath, repoId: "repo-a", ownerId: "owner-a", op: "ping" });
    assert.equal(validateReadyDashboardControlResponse(response, "capability"), true);

    const mismatch = await rawRequest(
      socketPath,
      Buffer.from(
        `${JSON.stringify({ protocol: DASHBOARD_CONTROL_PROTOCOL, repoId: "repo-a", ownerId: "wrong", op: "ping" })}\n`,
      ),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error, "identity_mismatch");
    assert.equal(mismatch.launchUrl, undefined);
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test("control rejects malformed and oversized requests without invoking hooks", async () => {
  const socketPath = path.join(temporaryDirectory(), "control.sock");
  let focused = 0;
  const server = await startDashboardControlServer({
    socketPath,
    repoId: "repo",
    ownerId: "owner",
    getState: () => "starting",
    focus: () => {
      focused++;
      return true;
    },
    maxBytes: 128,
  });
  try {
    assert.equal((await rawRequest(socketPath, Buffer.from("not-json\n"))).error, "malformed_request");
    assert.equal((await rawRequest(socketPath, Buffer.from(`${"x".repeat(129)}\n`))).error, "request_too_large");
    assert.equal(focused, 0);
  } finally {
    await server.close();
  }
});

test("shutdown acknowledges promptly without awaiting command stop work", async () => {
  const socketPath = path.join(temporaryDirectory(), "control.sock");
  let resolveStop!: () => void;
  const stopWork = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  let requested = 0;
  const server = await startDashboardControlServer({
    socketPath,
    repoId: "repo",
    ownerId: "owner",
    getState: () => "shutting-down",
    requestStop: async () => {
      requested++;
      await stopWork;
    },
  });
  try {
    const shutdown = await requestDashboardControl({ socketPath, repoId: "repo", ownerId: "owner", op: "shutdown" });
    assert.equal(shutdown.ok, true);
    assert.equal(shutdown.state, "shutting-down");
    assert.equal(requested, 1);
  } finally {
    resolveStop();
    await server.close();
  }
});

test("focus requires an explicit success and gets its bounded operation timeout", async () => {
  const socketPath = path.join(temporaryDirectory(), "control.sock");
  let resolveFocus!: (focused: boolean) => void;
  const server = await startDashboardControlServer({
    socketPath,
    repoId: "repo",
    ownerId: "owner",
    getState: () => "ready",
    getLaunchUrl: () => `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=token`,
    focus: () => new Promise<boolean>((resolve) => (resolveFocus = resolve)),
    timeoutMs: 10,
    focusTimeoutMs: 100,
  });
  try {
    const focus = requestDashboardControl({
      socketPath,
      repoId: "repo",
      ownerId: "owner",
      op: "focus",
      timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    resolveFocus(false);
    const response = await focus;
    assert.equal(response.ok, false);
    assert.equal(response.error, "focus_unavailable");
  } finally {
    await server.close();
  }
});

test("concurrent focus requests share one bounded operation and report timeout honestly", async () => {
  const socketPath = path.join(temporaryDirectory(), "control.sock");
  let focused = 0;
  const server = await startDashboardControlServer({
    socketPath,
    repoId: "repo",
    ownerId: "owner",
    getState: () => "ready",
    focus: () => {
      focused++;
      return new Promise<boolean>(() => undefined);
    },
    timeoutMs: 10,
    focusTimeoutMs: 30,
  });
  try {
    const responses = await Promise.all([
      requestDashboardControl({ socketPath, repoId: "repo", ownerId: "owner", op: "focus", timeoutMs: 100 }),
      requestDashboardControl({ socketPath, repoId: "repo", ownerId: "owner", op: "focus", timeoutMs: 100 }),
      requestDashboardControl({ socketPath, repoId: "repo", ownerId: "owner", op: "focus", timeoutMs: 100 }),
    ]);
    assert.equal(focused, 1);
    assert.deepEqual(
      responses.map((response) => ({ ok: response.ok, error: response.error })),
      [
        { ok: false, error: "focus_unavailable" },
        { ok: false, error: "focus_unavailable" },
        { ok: false, error: "focus_unavailable" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("owner-specific sockets never require unlinking another owner's path", async () => {
  const directory = temporaryDirectory();
  const oldPath = dashboardOwnerSocketPath(directory, "scope", "old");
  const successorPath = dashboardOwnerSocketPath(directory, "scope", "successor");
  const oldServer = await startDashboardControlServer({
    socketPath: oldPath,
    repoId: "repo",
    ownerId: "old",
    getState: () => "shutting-down",
  });
  const successor = await startDashboardControlServer({
    socketPath: successorPath,
    repoId: "repo",
    ownerId: "successor",
    getState: () => "ready",
  });
  try {
    await oldServer.close();
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.lstatSync(successorPath).isSocket(), true);
  } finally {
    await successor.close();
  }
});
