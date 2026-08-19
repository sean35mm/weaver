import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requestDashboardControl } from "../../src/dashboard/control.ts";
import { dashboardOwnerSocketPath, dashboardRuntimePaths } from "../../src/dashboard/runtime.ts";
import { openStore } from "../../src/store/open.ts";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "src/cli.ts");

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEAVER_HOME: home,
    NO_COLOR: "1",
    WEAVER_SESSION: "dashboard-launcher-context",
  };
  delete env.FORCE_COLOR;
  delete env.CMUX_SOCKET;
  delete env.CMUX_SOCKET_PATH;
  delete env.CMUX_SURFACE_ID;
  delete env.CMUX_WORKSPACE_ID;
  return env;
}

function startDashboard(cwd: string, home: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [cliPath, "dashboard", ...args], {
    cwd,
    env: cleanEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function launchUrlPattern(): RegExp {
  return /(http:\/\/127\.0\.0\.1:\d+\/\?instance=[A-Za-z0-9_-]{22}#cap=[A-Za-z0-9_-]+)/;
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 8_000,
): Promise<{ stdout: string; stderr: string; match: RegExpExecArray }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`timed out waiting for output: ${stdout}${stderr}`)), timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve({ stdout, stderr, match: pattern.exec(stdout)! });
    };
    const check = (): void => {
      pattern.lastIndex = 0;
      if (pattern.test(stdout)) finish();
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      check();
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null): void => finish(new Error(`process exited ${code}: ${stdout}${stderr}`));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function collectOutput(child: ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => child.once("close", () => resolve({ stdout, stderr })));
}

function waitForOutputAfterExit(child: ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  return collectOutput(child);
}

async function stopExactChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

test("concurrent dashboard follower reuses one owner and owner SIGINT removes lease and socket", {
  timeout: 25_000,
}, async () => {
  const cwd = temporaryDirectory("weaver-dashboard-repo-");
  const home = temporaryDirectory("weaver-dashboard-home-");
  const owner = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
  const children = [owner];
  let socketPath = "";
  try {
    const ready = await waitForOutput(owner, launchUrlPattern());
    const launchUrl = ready.match[1]!;
    const parsedLaunchUrl = new URL(launchUrl);
    assert.deepEqual([...parsedLaunchUrl.searchParams.keys()], ["instance"]);
    assert.match(parsedLaunchUrl.searchParams.get("instance") ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.equal(owner.exitCode, null, "the elected owner remains in the foreground");

    const follower = startDashboard(cwd, home, ["--no-open", "--port", "65535"]);
    children.push(follower);
    const followerOutputPromise = collectOutput(follower);
    assert.equal(await waitForExit(follower), 0);
    const followerOutput = await followerOutputPromise;
    assert.match(followerOutput.stdout, /requested --port 65535 ignored/);
    assert.equal(followerOutput.stdout.includes(launchUrl), true);
    assert.equal(owner.exitCode, null, "the follower exits without stopping the owner");

    const dbFiles = fs.readdirSync(home).filter((entry) => entry.endsWith(".db"));
    assert.equal(dbFiles.length, 1);
    const repoId = dbFiles[0]!.slice(0, -3);
    const store = await openStore(path.join(home, dbFiles[0]!));
    const runtime = dashboardRuntimePaths({ repoId, ownerId: "unused", weaverHome: home });
    const lease = store.getDashboardLease(runtime.scopeId);
    assert.ok(lease);
    assert.equal(lease.ownerPid, owner.pid);
    socketPath = dashboardOwnerSocketPath(runtime.directory, runtime.scopeId, lease.ownerId);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);

    const capability = new URLSearchParams(parsedLaunchUrl.hash.slice(1)).get("cap");
    assert.ok(capability);
    const created = await fetch(`${new URL(launchUrl).origin}/api/scratchpads`, {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "neutral dashboard revision", body: "body" }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { pad: { id: number } }).pad.id;
    const revision = store.listScratchpadRevisions(id, 1)[0]!;
    assert.equal(revision.actorId, null);
    assert.equal(revision.actorHarness, null);
    assert.equal(revision.worktreeId, null);
    store.close();

    owner.kill("SIGINT");
    assert.equal(await waitForExit(owner), 0);
    const after = await openStore(path.join(home, dbFiles[0]!));
    assert.equal(after.getDashboardLease(runtime.scopeId), undefined);
    after.close();
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await Promise.all(children.map((child) => stopExactChild(child).catch(() => undefined)));
  }
});

test("simultaneous fresh dashboards converge on one URL and authenticated shutdown fully tears down the owner", {
  timeout: 25_000,
}, async () => {
  const cwd = temporaryDirectory("weaver-dashboard-simultaneous-repo-");
  const home = temporaryDirectory("weaver-dashboard-simultaneous-home-");
  const first = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
  const second = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
  const children = [first, second];
  try {
    const urlPattern = launchUrlPattern();
    const [firstOutput, secondOutput] = await Promise.all([
      waitForOutput(first, urlPattern),
      waitForOutput(second, urlPattern),
    ]);
    assert.equal(firstOutput.match[1], secondOutput.match[1]);
    assert.equal(
      [firstOutput.stdout, secondOutput.stdout].filter((output) => output.includes("scratchpads already running"))
        .length,
      1,
    );

    const follower = firstOutput.stdout.includes("scratchpads already running") ? first : second;
    const owner = follower === first ? second : first;
    assert.equal(await waitForExit(follower), 0);
    assert.equal(owner.exitCode, null);

    const dbFiles = fs.readdirSync(home).filter((entry) => entry.endsWith(".db"));
    assert.equal(dbFiles.length, 1);
    const repoId = dbFiles[0]!.slice(0, -3);
    const dbPath = path.join(home, dbFiles[0]!);
    const store = await openStore(dbPath);
    const runtime = dashboardRuntimePaths({ repoId, ownerId: "unused", weaverHome: home });
    const lease = store.getDashboardLease(runtime.scopeId);
    assert.ok(lease);
    assert.equal(lease.ownerPid, owner.pid);
    const socketPath = dashboardOwnerSocketPath(runtime.directory, runtime.scopeId, lease.ownerId);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    store.close();

    const response = await requestDashboardControl({
      socketPath,
      repoId,
      ownerId: lease.ownerId,
      op: "shutdown",
    });
    assert.equal(response.ok, true);
    assert.equal(response.state, "shutting-down");
    assert.equal(await waitForExit(owner), 0);

    const after = await openStore(dbPath);
    assert.equal(after.getDashboardLease(runtime.scopeId), undefined);
    after.close();
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await Promise.all(children.map((child) => stopExactChild(child).catch(() => undefined)));
  }
});

test("dashboard ownership loss exits nonzero only after lease and socket cleanup", { timeout: 20_000 }, async () => {
  const cwd = temporaryDirectory("weaver-dashboard-loss-repo-");
  const home = temporaryDirectory("weaver-dashboard-loss-home-");
  const owner = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
  const children = [owner];
  try {
    await waitForOutput(owner, launchUrlPattern());
    const dbFiles = fs.readdirSync(home).filter((entry) => entry.endsWith(".db"));
    assert.equal(dbFiles.length, 1);
    const repoId = dbFiles[0]!.slice(0, -3);
    const dbPath = path.join(home, dbFiles[0]!);
    const store = await openStore(dbPath);
    const runtime = dashboardRuntimePaths({ repoId, ownerId: "unused", weaverHome: home });
    const lease = store.getDashboardLease(runtime.scopeId);
    assert.ok(lease);
    const socketPath = dashboardOwnerSocketPath(runtime.directory, runtime.scopeId, lease.ownerId);
    assert.equal(store.releaseDashboardLease(runtime.scopeId, lease.ownerId), true);
    assert.equal(
      store.tryAcquireDashboardLease({
        scopeId: runtime.scopeId,
        ownerId: "successor",
        ownerPid: process.pid,
        renewedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      true,
    );
    store.close();

    const output = waitForOutputAfterExit(owner);
    assert.equal(await waitForExit(owner), 1);
    const completed = await output;
    assert.match(completed.stderr, /dashboard ownership lost: dashboard lease renewal was rejected/);
    assert.doesNotMatch(completed.stdout, /scratchpads stopped/);
    assert.equal(fs.existsSync(socketPath), false);

    const after = await openStore(dbPath);
    assert.equal(after.getDashboardLease(runtime.scopeId)?.ownerId, "successor");
    after.close();
  } finally {
    await Promise.all(children.map((child) => stopExactChild(child).catch(() => undefined)));
  }
});

test("a fresh dashboard takes over after a crashed owner's lease expires", { timeout: 35_000 }, async () => {
  const cwd = temporaryDirectory("weaver-dashboard-takeover-repo-");
  const home = temporaryDirectory("weaver-dashboard-takeover-home-");
  const deadOwner = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
  const children = [deadOwner];
  try {
    await waitForOutput(deadOwner, launchUrlPattern());
    const dbFiles = fs.readdirSync(home).filter((entry) => entry.endsWith(".db"));
    assert.equal(dbFiles.length, 1);
    const dbPath = path.join(home, dbFiles[0]!);
    const before = await openStore(dbPath);
    const staleLease = before.getDashboardLease(
      dashboardRuntimePaths({ repoId: dbFiles[0]!.slice(0, -3), ownerId: "unused", weaverHome: home }).scopeId,
    );
    assert.ok(staleLease);
    before.close();

    assert.equal(deadOwner.kill("SIGKILL"), true);
    assert.equal(await waitForExit(deadOwner), null);

    const replacement = startDashboard(cwd, home, ["--no-open", "--port", "0"]);
    children.push(replacement);
    const ready = await waitForOutput(replacement, launchUrlPattern(), 25_000);
    assert.match(ready.stdout, /weaver scratchpads/);

    const after = await openStore(dbPath);
    const replacementLease = after.getDashboardLease(staleLease.scopeId);
    assert.ok(replacementLease);
    assert.equal(replacementLease.ownerPid, replacement.pid);
    assert.notEqual(replacementLease.ownerId, staleLease.ownerId);
    after.close();
  } finally {
    await Promise.all(children.map((child) => stopExactChild(child).catch(() => undefined)));
  }
});
