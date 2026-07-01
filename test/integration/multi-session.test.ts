import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveRepoId } from "../../src/repo/identity.ts";
import { openDb } from "../../src/store/db.ts";

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

function run(
  cwd: string,
  home: string,
  session: string | null,
  args: string[],
): { status: number; stdout: string; stderr: string } {
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
  assert.equal(
    parsed.sessions.some((s) => s.id),
    false,
  );
  assert.equal(
    parsed.completed.some((s) => s.id),
    false,
  );
  assert.ok(parsed.sessions.some((s) => s.shortId));
  assert.ok(parsed.completed.some((s) => s.intent === "build auth flow"));
  assert.equal(
    parsed.claims.some((c) => c.pattern === "src/disabled/**"),
    false,
  );

  const selfStatus = cli("agent-a", ["status", "--json", "--full"]);
  const selfParsed = JSON.parse(selfStatus.stdout) as { completed: Array<{ intent: string | null }> };
  assert.equal(
    selfParsed.completed.some((s) => s.intent === "build auth flow"),
    false,
  );
});

test("note --update supersedes, inherits pin, and rejects unknown ids", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  const first = run(root, home, "agent-a", ["note", "old learning", "--pin"]);
  assert.equal(first.status, 0);
  const firstId = Number(/#(\d+)/.exec(first.stdout)?.[1]);
  assert.ok(Number.isInteger(firstId));

  const updated = run(root, home, "agent-a", ["note", "new learning", "--update", String(firstId)]);
  assert.equal(updated.status, 0);
  assert.match(updated.stdout, /\(pinned\)/); // inherited from the superseded note
  assert.match(updated.stdout, new RegExp(`supersedes #${firstId}`));

  const notes = run(root, home, "agent-a", ["notes"]);
  assert.match(notes.stdout, /new learning/);
  assert.doesNotMatch(notes.stdout, /old learning/);

  const missing = run(root, home, "agent-a", ["note", "x", "--update", "9999"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /note #9999 not found/);

  const garbage = run(root, home, "agent-a", ["note", "x", "--update", "abc"]);
  assert.equal(garbage.status, 1);
  assert.match(garbage.stderr, /--update expects a note id/);
});

test("notes --path uses overlap matching and keeps unscoped notes quiet unless pinned", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  assert.equal(
    run(root, home, "agent-a", ["note", "backend area", "--path", "apps/backend/**", "--tag", "backend"]).status,
    0,
  );
  assert.equal(
    run(root, home, "agent-a", ["note", "exact file", "--path", "apps/backend/app/Foo.php", "--tag", "backend"]).status,
    0,
  );
  assert.equal(
    run(root, home, "agent-a", ["note", "frontend area", "--path", "apps/frontend/**", "--tag", "frontend"]).status,
    0,
  );
  assert.equal(run(root, home, "agent-a", ["note", "global plain"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["note", "global pinned", "--pin"]).status, 0);

  const byPath = run(root, home, null, ["notes", "--path", "apps/backend/app/Foo.php"]);
  assert.equal(byPath.status, 0);
  assert.match(byPath.stdout, /backend area/);
  assert.match(byPath.stdout, /exact file/);
  assert.match(byPath.stdout, /global pinned/);
  assert.doesNotMatch(byPath.stdout, /frontend area/);
  assert.doesNotMatch(byPath.stdout, /global plain/);

  const byTag = run(root, home, null, ["notes", "--tag", "backend"]);
  assert.equal(byTag.status, 0);
  assert.match(byTag.stdout, /backend area/);
  assert.match(byTag.stdout, /exact file/);
  assert.doesNotMatch(byTag.stdout, /frontend area/);
});

test("forget retires a note (hidden, audited, recoverable), rejects unknown ids", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  const noted = run(root, home, "agent-a", ["note", "npm publish works"]);
  const id = /#(\d+)/.exec(noted.stdout)?.[1];
  assert.ok(id);

  const missingReason = run(root, home, "agent-a", ["forget", id!]);
  assert.equal(missingReason.status, 1); // a forget must leave a why

  const forgot = run(root, home, "agent-a", ["forget", id!, "npm distribution was removed"]);
  assert.equal(forgot.status, 0);
  assert.match(forgot.stdout, /retired note #\d+/);

  assert.doesNotMatch(run(root, home, "agent-a", ["notes"]).stdout, /npm publish works/);
  const all = run(root, home, "agent-a", ["notes", "--all"]);
  assert.match(all.stdout, /npm publish works.*retired: npm distribution was removed/);

  // audited in the activity feed, idempotent on retry, recoverable
  assert.match(run(root, home, "viewer", ["activity"]).stdout, /forget.*npm distribution was removed/);
  const again = run(root, home, "agent-a", ["forget", id!, "x"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already retired/);
  assert.equal(run(root, home, "agent-a", ["forget", "--undo", id!]).status, 0);
  assert.match(run(root, home, "agent-a", ["notes"]).stdout, /npm publish works/);

  const unknown = run(root, home, "agent-a", ["forget", "9999", "whatever"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /note #9999 not found/);
});

test("read-only commands transparently migrate a v1 store", async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  // the spawned CLI sees the symlink-resolved cwd (macOS /var → /private/var), so the store
  // path must be derived from the resolved root to land where the CLI will look
  const repoId = resolveRepoId(fs.realpathSync(root)).repoId;

  // hand-craft a v1-era store at the real path
  const raw = await openDb(path.join(home, `${repoId}.db`));
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, id_source TEXT NOT NULL, pid INTEGER,
      cwd TEXT, intent TEXT, started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, harness TEXT, body TEXT NOT NULL,
      path TEXT, tags TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      supersedes INTEGER
    );
    CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO weaver_meta (key, value) VALUES ('schema_version', '1');
    INSERT INTO notes (body, created_at) VALUES ('survives the upgrade', 1);
  `);
  raw.close();

  // a pure reader on the old store must not crash on the new columns
  const notes = run(root, home, null, ["notes"]);
  assert.equal(notes.status, 0);
  assert.match(notes.stdout, /survives the upgrade/);

  const status = run(root, home, null, ["status", "--json"]);
  assert.equal(status.status, 0);
});

test("status surfaces unpinned notes in an otherwise quiet repo", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  assert.equal(run(root, home, "agent-a", ["note", "pg runs on :5433 in tests"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["done"]).status, 0);

  // Self is excluded everywhere, so the unpinned note is the only thing left to show.
  const status = run(root, home, "agent-a", ["status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /pg runs on :5433 in tests/);
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

test("audit with missing store does not create Weaver home", () => {
  const root = tmpDir("weaver-repo-");
  const home = path.join(root, "missing-home");

  const result = run(root, home, null, ["audit", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(home), false);
  const parsed = JSON.parse(result.stdout) as { sessions: { total: number }; recommendations: string[] };
  assert.equal(parsed.sessions.total, 0);
  assert.ok(Array.isArray(parsed.recommendations));
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

test("hook pre-edit warns about another session's claim; post-edit registers presence", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  function hook(event: string, payload: unknown) {
    const result = spawnSync(process.execPath, [cliPath, "hook", event], {
      cwd: root,
      env: env(home, null),
      encoding: "utf8",
      input: JSON.stringify(payload),
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  assert.equal(run(root, home, "alice", ["task", "auth refactor"]).status, 0);
  assert.equal(run(root, home, "alice", ["claim", "src/auth/**", "--reason", "token flow"]).status, 0);

  const conflicted = hook("pre-edit", {
    session_id: "claude-sess",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "src/auth/login.ts") },
  });
  assert.equal(conflicted.status, 0); // advisory: never blocks, never fails
  const parsed = JSON.parse(conflicted.stdout) as {
    hookSpecificOutput: { permissionDecision: string; additionalContext: string };
  };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(parsed.hookSpecificOutput.additionalContext, /token flow/);

  // an unchanged conflict picture is not re-announced on the next edit (cooldown)
  const repeat = hook("pre-edit", {
    session_id: "claude-sess",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "src/auth/login.ts") },
  });
  assert.equal(repeat.status, 0);
  assert.equal(repeat.stdout, "");

  const clear = hook("pre-edit", {
    session_id: "claude-sess",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "docs/notes.md") },
  });
  assert.equal(clear.status, 0);
  assert.equal(clear.stdout, "");

  const post = hook("post-edit", {
    session_id: "claude-sess",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "src/web/app.ts") },
  });
  assert.equal(post.status, 0);
  assert.equal(post.stdout, "");

  const status = run(root, home, "viewer", ["status", "--json", "--full"]);
  const statusParsed = JSON.parse(status.stdout) as {
    sessions: Array<{ harness: string }>;
    recentActivity: Array<{ kind: string; target: string | null }>;
  };
  assert.ok(statusParsed.sessions.some((s) => s.harness === "claude-code"));
  assert.ok(statusParsed.recentActivity.some((a) => a.kind === "edit" && a.target === "src/web/app.ts"));

  // garbage stdin must be silent and harmless
  const garbage = spawnSync(process.execPath, [cliPath, "hook", "pre-edit"], {
    cwd: root,
    env: env(home, null),
    encoding: "utf8",
    input: "not json{",
  });
  assert.equal(garbage.status ?? 1, 0);
  assert.equal(garbage.stdout, "");
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
  const parsed = JSON.parse(result.stdout) as {
    severity: string;
    recommendation: string;
    conflicts: Array<{ path: string; tier: string }>;
  };
  assert.equal(parsed.severity, "hard");
  assert.equal(parsed.recommendation, "ask-user");
  assert.deepEqual(
    parsed.conflicts.map((c) => [c.path, c.tier]),
    [["src/auth/login.ts", "hard"]],
  );

  const reportOnly = run(root, home, "agent-b", [
    "preflight",
    "--staged",
    "--operation",
    "commit",
    "--fail-on",
    "never",
  ]);
  assert.equal(reportOnly.status, 0);
});
