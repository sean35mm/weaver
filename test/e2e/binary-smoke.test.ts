/**
 * Smoke test for the shipped artifact: compiles the standalone binary exactly like a release
 * (bun --compile) and runs the core agent story against it. Everything else in the suite runs
 * source through node/bun — this is the only place the distributed binary itself executes.
 * Not part of `npm test` (needs bun and a compile step); run via `npm run test:e2e-binary`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const launchUrlPattern = /http:\/\/127\.0\.0\.1:\d+\/\?instance=[A-Za-z0-9_-]{22}#cap=[A-Za-z0-9_-]+/;

function redactCapabilities(output: string): string {
  return output.replace(/(#cap=)[A-Za-z0-9_-]+/g, "$1<redacted>");
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

test("compiled standalone binary runs the core agent story and scratchpad UI", {
  skip: !bunAvailable && "bun is not installed",
  timeout: 120_000,
}, async () => {
  const bin = path.join(tmpDir("weaver-bin-"), "weaver-smoke");
  execFileSync("bun", ["build", "src/cli.ts", "--compile", `--outfile=${bin}`], {
    cwd: repoRoot,
    stdio: "ignore",
  });

  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const environment = (session: string | null): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, WEAVER_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.OPENCODE_RUN_ID;
    if (session) env.WEAVER_SESSION = session;
    else delete env.WEAVER_SESSION;
    return env;
  };
  const run = (session: string | null, args: string[]): { status: number; stdout: string; stderr: string } => {
    const env = environment(session);
    const result = spawnSync(bin, args, { cwd: root, env, encoding: "utf8", input: "" });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };

  // the artifact reports a version (the dev sentinel outside release builds)
  const version = run(null, ["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

  // init installs the instruction files
  assert.equal(run(null, ["init", "--project", "--no-hooks"]).status, 0);
  assert.ok(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").includes("weaver"));
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")));

  // agent story: task → claim → conflicting check → preflight → status → done
  assert.equal(run("agent-a", ["task", "auth refactor"]).status, 0);
  assert.equal(run("agent-a", ["claim", "src/auth/**", "--reason", "token flow"]).status, 0);

  const conflict = run("agent-b", ["check", "src/auth/login.ts"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /token flow/);

  const preflight = run("agent-b", ["preflight", "src/auth/login.ts", "--json"]);
  assert.equal(preflight.status, 1);
  assert.equal((JSON.parse(preflight.stdout) as { severity: string }).severity, "hard");

  const status = run("agent-b", ["status", "--json"]);
  assert.equal(status.status, 0);
  const parsed = JSON.parse(status.stdout) as { sessions: unknown[]; claims: unknown[] };
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.claims.length, 1);

  assert.equal(run("agent-a", ["done"]).status, 0);
  const after = run("agent-b", ["status", "--json"]);
  const afterParsed = JSON.parse(after.stdout) as { sessions: unknown[]; claims: unknown[] };
  assert.equal(afterParsed.sessions.length, 0);
  assert.equal(afterParsed.claims.length, 0);

  const created = run(null, ["scratchpad", "create", "Binary pad", "--json"]);
  assert.equal(created.status, 0);
  assert.equal((JSON.parse(created.stdout) as { title: string }).title, "Binary pad");
  const read = run(null, ["scratchpad", "read", "1", "--json"]);
  assert.equal(read.status, 0);
  assert.equal((JSON.parse(read.stdout) as { id: number }).id, 1);

  const dashboard = spawn(bin, ["scratchpads", "--port", "0", "--no-open", "--color=never"], {
    cwd: root,
    env: environment(null),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const launchUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`scratchpads did not print a URL: ${redactCapabilities(output)}`)),
        10_000,
      );
      dashboard.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = launchUrlPattern.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      dashboard.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      dashboard.once("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`scratchpads exited ${code}`));
        }
      });
    });
    const parsedUrl = new URL(launchUrl);
    const token = new URLSearchParams(parsedUrl.hash.slice(1)).get("cap");
    assert.ok(token);
    assert.match(parsedUrl.searchParams.get("instance") ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual([...parsedUrl.searchParams.keys()], ["instance"]);
    parsedUrl.hash = "";
    const page = await fetch(parsedUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Weaver Scratchpads/);
    const asset = await fetch(new URL("/assets/app.js", parsedUrl));
    assert.equal(asset.status, 200);
    assert.ok((await asset.text()).length > 100_000);
    const snapshot = await fetch(new URL("/api/snapshot", parsedUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(snapshot.status, 200);
    const snapshotBody = (await snapshot.json()) as { pads: Array<{ title: string; body?: string }> };
    assert.equal(snapshotBody.pads[0]?.title, "Binary pad");
    assert.equal("body" in snapshotBody.pads[0]!, false);
  } finally {
    if (dashboard.exitCode === null) {
      dashboard.kill("SIGINT");
      await new Promise<void>((resolve) => dashboard.once("exit", () => resolve()));
    }
  }
});
