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
  const out: NodeJS.ProcessEnv = { ...process.env, WEAVER_HOME: home };
  delete out.CLAUDE_CODE_SESSION_ID;
  delete out.CODEX_THREAD_ID;
  delete out.OPENCODE_SESSION_ID;
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
  input = "",
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: env(home, session),
    encoding: "utf8",
    input,
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("multiple sessions coordinate through one store", { timeout: 10_000 }, () => {
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

test("real git worktrees share a store but treat overlapping files as isolated", { timeout: 15_000 }, () => {
  const root = tmpDir("weaver-worktree-repo-");
  const other = path.join(tmpDir("weaver-worktree-parent-"), "other");
  const home = tmpDir("weaver-home-");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = true;\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("worktree", "add", "-b", "other", other);

  assert.equal(run(root, home, "root-agent", ["task", "root work"]).status, 0);
  assert.equal(run(other, home, "other-agent", ["task", "other work"]).status, 0);
  assert.equal(run(root, home, "root-agent", ["claim", "src/app.ts", "--reason", "root edit"]).status, 0);

  const isolated = run(other, home, "other-agent", ["check", "src/app.ts"]);
  assert.equal(isolated.status, 0);
  assert.match(isolated.stdout, /OTHER WORKTREE/);

  const coClaim = run(other, home, "other-agent", ["claim", "src/app.ts", "--reason", "other edit"]);
  assert.equal(coClaim.status, 0);
  assert.match(coClaim.stdout, /OTHER WORKTREE/);

  const preflight = run(other, home, "other-agent", ["preflight", "src/app.ts", "--json"]);
  assert.equal(preflight.status, 0);
  const preflightJson = JSON.parse(preflight.stdout) as {
    severity: string;
    recommendation: string;
    informational: unknown[];
  };
  assert.equal(preflightJson.severity, "info");
  assert.equal(preflightJson.recommendation, "continue");
  assert.equal(preflightJson.informational.length, 1);

  const same = run(root, home, "same-root-agent", ["check", "src/app.ts"]);
  assert.equal(same.status, 1);
  assert.match(same.stdout, /CONFLICT/);

  // A reused fallback identity in two live checkouts is ambiguous: it must not silently
  // release the root claim or let done in the other checkout end the root presence.
  assert.equal(run(root, home, "reused-agent", ["task", "root work"]).status, 0);
  assert.equal(run(root, home, "reused-agent", ["claim", "src/reused.ts"]).status, 0);
  assert.equal(run(other, home, "reused-agent", ["task", "other work"]).status, 0);

  const thirdParty = run(root, home, "third-agent", ["check", "src/reused.ts"]);
  assert.equal(thirdParty.status, 1);
  assert.match(thirdParty.stdout, /CONFLICT/);

  assert.equal(run(other, home, "reused-agent", ["done"]).status, 0);
  const afterOtherDone = run(root, home, "third-agent", ["check", "src/reused.ts"]);
  assert.equal(afterOtherDone.status, 1);
  assert.match(afterOtherDone.stdout, /CONFLICT/);
});

test("a reused identity sees same-worktree status records excluded but different and unknown worktree records", {
  timeout: 15_000,
}, () => {
  const root = tmpDir("weaver-worktree-repo-");
  const other = path.join(tmpDir("weaver-worktree-parent-"), "other");
  const home = tmpDir("weaver-home-");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-m", "base");
  git("worktree", "add", "-b", "other", other);

  assert.equal(run(root, home, "reused", ["task", "root work"]).status, 0);
  assert.equal(run(root, home, "reused", ["claim", "src/self.ts"]).status, 0);
  assert.equal(run(root, home, "reused", ["log", "edit", "src/self.ts", "self edit"]).status, 0);
  const sameActive = JSON.parse(run(root, home, "reused", ["status", "--json", "--full"]).stdout) as {
    sessions: unknown[];
    claims: unknown[];
    recentActivity: unknown[];
  };
  assert.deepEqual(sameActive.sessions, []);
  assert.deepEqual(sameActive.claims, []);
  assert.deepEqual(sameActive.recentActivity, []);

  assert.equal(run(root, home, "reused", ["done"]).status, 0);
  const sameCompleted = JSON.parse(run(root, home, "reused", ["status", "--json", "--full"]).stdout) as {
    completed: unknown[];
  };
  assert.deepEqual(sameCompleted.completed, []);

  const differentCompleted = JSON.parse(run(other, home, "reused", ["status", "--json", "--full"]).stdout) as {
    completed: Array<{ worktree: string }>;
  };
  assert.equal(differentCompleted.completed.length, 1);
  assert.notEqual(differentCompleted.completed[0]?.worktree, "unknown");

  assert.equal(run(root, home, "reused", ["task", "root work again"]).status, 0);
  assert.equal(run(root, home, "reused", ["claim", "src/app.ts"]).status, 0);
  assert.equal(run(root, home, "reused", ["log", "edit", "src/app.ts", "root edit"]).status, 0);
  const different = JSON.parse(run(other, home, "reused", ["status", "--json", "--full"]).stdout) as {
    sessions: unknown[];
    claims: Array<{ worktree: string }>;
    recentActivity: Array<{ worktree: string }>;
  };
  assert.equal(different.sessions.length, 1);
  assert.ok(different.claims.some((claim) => claim.worktree !== "unknown"));
  assert.ok(different.recentActivity.some((activity) => activity.worktree !== "unknown"));

  assert.equal(run(other, home, "reused", ["task", "other work"]).status, 0);
  const unknown = JSON.parse(run(other, home, "reused", ["status", "--json", "--full"]).stdout) as {
    sessions: Array<{ worktree: string }>;
    claims: Array<{ worktree: string }>;
    recentActivity: Array<{ worktree: string }>;
  };
  assert.ok(unknown.sessions.some((session) => session.worktree === "unknown"));
  assert.ok(unknown.claims.some((claim) => claim.worktree !== "unknown"));
  assert.ok(unknown.recentActivity.some((activity) => activity.worktree !== "unknown"));
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

test("scratchpad CLI supports shared lifecycle, bounded JSON reads, attribution, and fact aliases", {
  timeout: 15_000,
}, () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  const created = run(
    root,
    home,
    null,
    ["scratchpad", "create", "Shared", "plan", "--from", "-", "--json"],
    "# Plan\r\nfirst\r\n",
  );
  assert.equal(created.status, 0);
  const createdJson = JSON.parse(created.stdout) as { id: number; title: string; revision: number };
  assert.equal(createdJson.title, "Shared plan");
  assert.equal(createdJson.revision, 1);

  const source = path.join(root, "pad.md");
  fs.writeFileSync(source, "# File\nfrom file\n```md\n# Not a heading\n```\n## Real child\nchild\n# Next\nafter\n");
  const fromFile = run(root, home, null, ["scratchpad", "create", "File pad", "--from", source, "--json"]);
  assert.equal(fromFile.status, 0);
  const fromFileId = (JSON.parse(fromFile.stdout) as { id: number }).id;
  const fileRead = JSON.parse(
    run(root, home, null, ["scratchpad", "read", String(fromFileId), "--full", "--json"]).stdout,
  ) as { content: string };
  assert.match(fileRead.content, /# Not a heading/);
  const fileHeadings = JSON.parse(
    run(root, home, null, ["scratchpad", "read", String(fromFileId), "--headings", "--json"]).stdout,
  ) as { content: string };
  assert.equal(fileHeadings.content, "# File\n## Real child\n# Next");
  const fileSection = JSON.parse(
    run(root, home, null, ["scratchpad", "read", String(fromFileId), "--section", "File", "--json"]).stdout,
  ) as { content: string };
  assert.match(fileSection.content, /# Not a heading/);
  assert.doesNotMatch(fileSection.content, /# Next/);

  const id = String(createdJson.id);
  assert.equal(run(root, home, "agent-a", ["scratchpad", "use", id]).status, 0);
  assert.equal(run(root, home, "agent-a", ["claim", "src/shared/**"]).status, 0);
  const status = JSON.parse(run(root, home, "viewer", ["status", "--json", "--full"]).stdout) as {
    claims: Array<{ scratchpadId: number | null }>;
    scratchpads: Array<Record<string, unknown>>;
  };
  assert.ok(status.claims.some((claim) => claim.scratchpadId === createdJson.id));
  assert.equal(status.scratchpads[0]?.body, undefined);

  const appended = run(
    root,
    home,
    "agent-a",
    ["scratchpad", "append", id, "--revision", "1", "--from", "-", "--json"],
    "second",
  );
  assert.equal(appended.status, 0);
  assert.equal((JSON.parse(appended.stdout) as { revision: number }).revision, 2);
  const missingRevision = run(root, home, "agent-a", ["scratchpad", "append", id, "--from", "-"], "lost");
  assert.equal(missingRevision.status, 1);
  assert.match(missingRevision.stderr, /mutation requires --revision/);
  const stale = run(root, home, "agent-a", ["scratchpad", "append", id, "--revision", "1", "--from", "-"], "lost");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /expected 1, current is 2/);

  const headings = JSON.parse(run(root, home, null, ["scratchpad", "read", id, "--headings", "--json"]).stdout) as {
    content: string;
    mode: string;
  };
  assert.equal(headings.content, "# Plan");
  assert.equal(headings.mode, "headings");

  assert.equal(run(root, home, "agent-b", ["config", "session_ttl_seconds", "1"]).status, 0);

  assert.equal(run(root, home, "agent-b", ["scratchpad", "use", id]).status, 0);
  const guarded = run(root, home, "agent-a", ["scratchpad", "archive", id, "--revision", "2"]);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /other live attachment/);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  assert.equal(run(root, home, "agent-a", ["scratchpad", "archive", id, "--revision", "2"]).status, 0);
  assert.equal(run(root, home, null, ["scratchpad", "restore", id, "--revision", "3"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["scratchpad", "use", id]).status, 0);

  const unsafeTrash = run(root, home, "agent-a", ["scratchpad", "trash", id, "--reason", "obsolete"]);
  assert.equal(unsafeTrash.status, 1);
  assert.match(unsafeTrash.stderr, /requires --revision/);
  assert.equal(
    run(root, home, "agent-a", ["scratchpad", "trash", id, "--revision", "4", "--reason", "obsolete"]).status,
    0,
  );
  assert.equal(run(root, home, null, ["scratchpad", "recover", id, "--revision", "5"]).status, 0);

  assert.equal(run(root, home, "agent-a", ["fact", "scratchpads are repo scoped"]).status, 0);
  assert.match(run(root, home, null, ["facts"]).stdout, /scratchpads are repo scoped/);
  assert.match(run(root, home, null, ["notes"]).stdout, /scratchpads are repo scoped/);
});

test("scratchpad edit uses a 0600 draft and rejects a concurrent revision without overwriting it", {
  timeout: 15_000,
}, async () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const created = run(root, home, null, ["scratchpad", "create", "Editor pad", "--from", "-", "--json"], "# Draft\n");
  const id = String((JSON.parse(created.stdout) as { id: number }).id);
  const marker = path.join(root, "draft-mode.txt");
  const editor = path.join(root, "editor.mjs");
  fs.writeFileSync(
    editor,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ mode: fs.statSync(process.argv[2]).mode & 0o777, completedAt: Date.now() }));\nfs.appendFileSync(process.argv[2], "edited\\n");\n`,
  );
  const oldVisual = process.env.VISUAL;
  process.env.VISUAL = `"${process.execPath}" "${editor}"`;
  try {
    const edited = run(root, home, "agent-a", ["scratchpad", "edit", id, "--revision", "1", "--json"]);
    assert.equal(edited.status, 0);
    assert.equal((JSON.parse(edited.stdout) as { revision: number }).revision, 2);
    const editorResult = JSON.parse(fs.readFileSync(marker, "utf8")) as { mode: number; completedAt: number };
    assert.equal(editorResult.mode, 0o600);
    const history = JSON.parse(run(root, home, null, ["scratchpad", "history", id, "--json"]).stdout) as Array<{
      createdAt: number;
      provenance: string;
    }>;
    assert.equal(history[0]?.provenance, "cli-editor");
    assert.ok(history[0]!.createdAt >= editorResult.completedAt);
    const repoId = resolveRepoId(fs.realpathSync(root)).repoId;
    const db = await openDb(path.join(home, `${repoId}.db`), { readOnly: true });
    try {
      const completion = db.get<{ created_at: number; last_seen: number }>(
        `SELECT revisions.created_at, sessions.last_seen
         FROM scratchpad_revisions AS revisions
         JOIN sessions ON sessions.id = revisions.actor_id
         WHERE revisions.scratchpad_id = ? AND revisions.revision = 2 AND revisions.provenance = 'cli-editor'`,
        Number(id),
      );
      assert.ok(completion);
      assert.equal(completion.last_seen, completion.created_at);
    } finally {
      db.close();
    }

    const racingEditor = path.join(root, "racing-editor.mjs");
    fs.writeFileSync(
      racingEditor,
      `import { spawnSync } from "node:child_process";\nimport fs from "node:fs";\nspawnSync(process.execPath, [${JSON.stringify(cliPath)}, "scratchpad", "append", ${JSON.stringify(id)}, "--revision", "2", "--from", "-"], { cwd: ${JSON.stringify(root)}, env: process.env, input: "concurrent", encoding: "utf8" });\nfs.appendFileSync(process.argv[2], "local edit\\n");\n`,
    );
    process.env.VISUAL = `"${process.execPath}" "${racingEditor}"`;
    const raced = run(root, home, "agent-a", ["scratchpad", "edit", id, "--revision", "2"]);
    assert.equal(raced.status, 1);
    assert.match(raced.stderr, /expected 2, current is 3/);
    const draft = /draft preserved at (.+)\n/.exec(raced.stderr)?.[1];
    assert.ok(draft);
    assert.match(fs.readFileSync(draft!, "utf8"), /local edit/);
    fs.rmSync(path.dirname(draft!), { recursive: true, force: true });

    const current = JSON.parse(run(root, home, null, ["scratchpad", "read", id, "--full", "--json"]).stdout) as {
      content: string;
      revision: number;
    };
    assert.equal(current.revision, 3);
    assert.match(current.content, /concurrent/);
    assert.doesNotMatch(current.content, /local edit/);
  } finally {
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
  }
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

test("observer command usage is recorded without creating presence", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  assert.equal(run(root, home, "agent-a", ["task", "seed store"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["done"]).status, 0);

  assert.equal(run(root, home, "observer", ["status", "--json"]).status, 0);
  assert.equal(run(root, home, "observer", ["check", "src/app.ts", "--no-touch"]).status, 0);
  assert.equal(run(root, home, "observer", ["preflight", "src/app.ts", "--fail-on", "never", "--json"]).status, 0);

  const audit = run(root, home, "observer", ["audit", "--json"]);
  assert.equal(audit.status, 0);
  const parsed = JSON.parse(audit.stdout) as {
    commands: { byCommand: Record<string, number> };
    sessions: { active: number };
  };
  assert.equal(parsed.commands.byCommand.status, 1);
  assert.equal(parsed.commands.byCommand.check, 1);
  assert.equal(parsed.commands.byCommand.preflight, 1);
  assert.equal(parsed.commands.byCommand.audit, 1);
  assert.equal(parsed.sessions.active, 0);
});

test("observer commands survive an unwritable store", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const repoId = resolveRepoId(fs.realpathSync(root)).repoId;

  assert.equal(run(root, home, "agent-a", ["task", "seed store"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["done"]).status, 0);

  const dbPath = path.join(home, `${repoId}.db`);
  fs.chmodSync(dbPath, 0o444);
  try {
    const status = run(root, home, "observer", ["status", "--json"]);
    assert.equal(status.status, 0);
    const parsed = JSON.parse(status.stdout) as { sessions: unknown[] };
    assert.ok(Array.isArray(parsed.sessions));

    // usage metrics must degrade silently: the command works, nothing is recorded
    const audit = run(root, home, "observer", ["audit", "--json"]);
    assert.equal(audit.status, 0);
    const auditParsed = JSON.parse(audit.stdout) as { commands: { total: number } };
    assert.equal(auditParsed.commands.total, 0);
  } finally {
    fs.chmodSync(dbPath, 0o644);
  }
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
    [
      ["src/auth/login.ts", "hard"],
      ["src/auth/login.ts", "soft"],
    ],
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

test("entry points: help, version, and unknown commands", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  const help = run(root, home, null, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /commands:/);

  const version = run(root, home, null, ["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

  const unknown = run(root, home, null, ["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command: frobnicate/);
});

test("preflight --base and --upstream honor soft and hard thresholds", { timeout: 15_000 }, () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };

  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth", "login.ts"), "export const login = true;\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  fs.writeFileSync(path.join(root, "src", "auth", "login.ts"), "export const login = false;\n");
  git("add", ".");
  git("commit", "-m", "change login");

  // soft signal: another live session recently edited the same file, without a claim
  assert.equal(run(root, home, "agent-b", ["task", "auth cleanup"]).status, 0);
  assert.equal(run(root, home, "agent-b", ["log", "edit", "src/auth/login.ts", "tweak"]).status, 0);

  const soft = run(root, home, "agent-a", ["preflight", "--base", "main", "--operation", "pr", "--json"]);
  assert.equal(soft.status, 1); // default threshold is --fail-on soft
  assert.equal((JSON.parse(soft.stdout) as { severity: string }).severity, "soft");
  const softBelowHard = run(root, home, "agent-a", ["preflight", "--base", "main", "--fail-on", "hard"]);
  assert.equal(softBelowHard.status, 0); // soft overlap does not trip the hard threshold

  // hard signal: the other session claims the area (with an explicit ttl)
  const claim = run(root, home, "agent-b", ["claim", "src/auth/**", "--reason", "auth work", "--ttl", "30m"]);
  assert.equal(claim.status, 0);
  const hard = run(root, home, "agent-a", ["preflight", "--base", "main", "--fail-on", "hard", "--json"]);
  assert.equal(hard.status, 1);
  assert.equal((JSON.parse(hard.stdout) as { severity: string }).severity, "hard");

  // --upstream resolves the same branch diff through tracking info
  git("branch", "--set-upstream-to=main");
  const upstream = run(root, home, "agent-a", ["preflight", "--upstream", "--fail-on", "never", "--json"]);
  assert.equal(upstream.status, 0); // report-only
  assert.equal((JSON.parse(upstream.stdout) as { severity: string }).severity, "hard");
});

test("notes and activity support free-text queries and filters", () => {
  const root = tmpDir("weaver-repo-");
  const home = tmpDir("weaver-home-");

  assert.equal(run(root, home, "agent-a", ["task", "auth work"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["note", "pg runs on :5433 in tests", "--tag", "infra"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["note", "auth tokens rotate hourly"]).status, 0);
  assert.equal(run(root, home, "agent-a", ["log", "edit", "src/auth/login.ts", "extract token refresh"]).status, 0);

  const query = run(root, home, "agent-a", ["notes", "tokens"]);
  assert.equal(query.status, 0);
  assert.match(query.stdout, /auth tokens rotate hourly/);
  assert.doesNotMatch(query.stdout, /pg runs/);

  const jsonNotes = run(root, home, "agent-a", ["notes", "--json"]);
  assert.equal(jsonNotes.status, 0);
  assert.equal((JSON.parse(jsonNotes.stdout) as Array<{ body: string }>).length, 2);

  const byKind = run(root, home, "agent-a", ["activity", "--kind", "edit", "--json"]);
  const editRows = JSON.parse(byKind.stdout) as Array<{ kind: string }>;
  assert.equal(editRows.length, 1);
  assert.equal(editRows[0]?.kind, "edit");

  const byPath = run(root, home, "agent-a", ["activity", "--path", "src/auth/**", "--json"]);
  assert.ok((JSON.parse(byPath.stdout) as unknown[]).length >= 1);

  const byQuery = run(root, home, "agent-a", ["activity", "token", "refresh"]);
  assert.match(byQuery.stdout, /extract token refresh/);

  const since = run(root, home, "agent-a", ["activity", "--since", "30m", "--json"]);
  assert.ok((JSON.parse(since.stdout) as unknown[]).length >= 3);

  const badSince = run(root, home, "agent-a", ["activity", "--since", "eventually"]);
  assert.equal(badSince.status, 1);
  assert.match(badSince.stderr, /--since expects a duration/);
});
