import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolveRepoId } from "../../src/repo/identity.ts";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "src/cli.ts");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function env(home: string, session: string | null): NodeJS.ProcessEnv {
  const out = { ...process.env, WEAVER_HOME: home };
  delete out.CLAUDE_CODE_SESSION_ID;
  delete out.CODEX_THREAD_ID;
  delete out.OPENCODE_RUN_ID;
  if (session) out.WEAVER_SESSION = session;
  else delete out.WEAVER_SESSION;
  return out;
}

function run(cwd: string, home: string, session: string | null, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: env(home, session),
    encoding: "utf8",
    input: "",
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("multiple sessions coordinate through one store", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  function cli(session: string | null, args: string[]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: env(home, session),
      encoding: "utf8",
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  assert.equal(cli("agent-a", ["task", "build auth flow"]).status, 0);
  assert.equal(cli("agent-b", ["task", "review auth flow"]).status, 0);
  assert.equal(cli("agent-a", ["claim", "src/auth/**", "--reason", "login work"]).status, 0);

  const conflict = cli("agent-b", ["check", "src/auth/login.ts"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /CONFLICT/);

  const coClaim = cli("agent-b", ["claim", "src/auth/login.ts", "--reason", "review overlap"]);
  assert.equal(coClaim.status, 1);
  assert.match(coClaim.stdout, /claimed src\/auth\/login\.ts/);

  assert.equal(cli("agent-b", ["release", "src/auth/login.ts"]).status, 0);
  assert.equal(cli("agent-b", ["log", "edit", "src/auth/review.ts", "checked overlap"]).status, 0);
  assert.equal(cli("agent-a", ["note", "auth flow handoff", "--path", "src/auth", "--pin"]).status, 0);

  assert.equal(cli(null, ["disable"]).status, 0);
  const disabledClaim = cli("agent-b", ["claim", "src/disabled/**"]);
  assert.equal(disabledClaim.status, 0);
  assert.match(disabledClaim.stderr, /disabled/);
  assert.equal(cli(null, ["enable"]).status, 0);

  assert.equal(cli("agent-a", ["done"]).status, 0);

  const status = cli("viewer", ["status", "--json", "--full"]);
  assert.equal(status.status, 0);
  const parsed = JSON.parse(status.stdout) as {
    sessions: Array<{ harness: string; shortId?: string; id?: string }>;
    completed: Array<{ intent: string | null; shortId?: string; id?: string }>;
    claims: Array<{ pattern: string }>;
  };
  assert.equal(parsed.sessions.some((s) => s.id), false);
  assert.equal(parsed.completed.some((s) => s.id), false);
  assert.ok(parsed.sessions.some((s) => s.shortId));
  assert.ok(parsed.completed.some((s) => s.intent === "build auth flow"));
  assert.equal(parsed.claims.some((c) => c.pattern === "src/disabled/**"), false);

  const selfStatus = cli("agent-a", ["status", "--json", "--full"]);
  const selfParsed = JSON.parse(selfStatus.stdout) as { completed: Array<{ intent: string | null }> };
  assert.equal(selfParsed.completed.some((s) => s.intent === "build auth flow"), false);
});

test("observer status with missing store does not create Weaver home", () => {
  const root = tmpDir("weaver-repo-");
  const home = path.join(root, "missing-home");

  const result = run(root, home, null, ["status", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(home), false);
  const parsed = JSON.parse(result.stdout) as { sessions: unknown[]; claims: unknown[] };
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(parsed.claims, []);
});

test("observer status treats schema-less existing store as empty", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const repoId = resolveRepoId(root).repoId;
  fs.writeFileSync(path.join(home, `${repoId}.db`), "");

  const result = run(root, home, null, ["status", "--json"]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as { sessions: unknown[]; claims: unknown[] };
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(parsed.claims, []);
});

test("preflight with missing store does not create Weaver home", () => {
  const root = tmpDir("weaver-repo-");
  const home = path.join(root, "missing-home");

  const result = run(root, home, null, ["preflight", "src/app.ts", "--fail-on", "never", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(home), false);
  const parsed = JSON.parse(result.stdout) as { severity: string; conflicts: unknown[] };
  assert.equal(parsed.severity, "clear");
  assert.deepEqual(parsed.conflicts, []);
});

test("write bootstrap failures use the friendly error boundary", () => {
  const root = tmpDir("weaver-repo-");
  const home = path.join(root, "not-a-dir");
  fs.writeFileSync(home, "x");

  const result = run(root, home, "agent-a", ["task", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^weaver: unexpected error:/);
  assert.doesNotMatch(result.stderr, /fatal/);
});

test("preflight --staged reports relevant hard overlaps without polling", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth", "login.ts"), "export const login = true;\n");
  execFileSync("git", ["add", "src/auth/login.ts"], { cwd: root, stdio: "ignore" });

  assert.equal(run(root, home, "agent-a", ["task", "refactor auth"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["claim", "src/auth/**", "--reason", "login flow"]).status, 0);

  const result = run(root, home, "agent-b", ["preflight", "--staged", "--operation", "commit", "--json"]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as { severity: string; recommendation: string; conflicts: Array<{ path: string; tier: string }> };
  assert.equal(parsed.severity, "hard");
  assert.equal(parsed.recommendation, "ask-user");
  assert.deepEqual(parsed.conflicts.map((c) => [c.path, c.tier]), [["src/auth/login.ts", "hard"]]);

  const reportOnly = run(root, home, "agent-b", ["preflight", "--staged", "--operation", "commit", "--fail-on", "never"]);
  assert.equal(reportOnly.status, 0);
});
