import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { parseNameStatus, run as runCommand } from "../src/commands/preflight.ts";
import type { Ctx } from "../src/context.ts";
import { hasBroadClaim, runPreflight } from "../src/preflight.ts";
import { openStore } from "../src/store/open.ts";
import type { IdSource, Store } from "../src/store/store.ts";
import { stripAnsi } from "../src/terminal/color.ts";
import { CliError } from "../src/validate.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-pf-")), "s.db");
}

const NOW = 1_000_000;
const SESSION_TTL = 15 * 60 * 1000;
const RECENT = 20 * 60 * 1000;

async function store() {
  return openStore(tmpDb());
}

function ctxFor(store: Store, idKey: string | null, now: number, argv: string[]): Ctx {
  return {
    store,
    identity: idKey ? { key: idKey, source: "explicit" as IdSource, label: "test" } : null,
    repo: { repoId: "r", root: "/repo", basis: "path" },
    config: { sessionTtlMs: SESSION_TTL, claimTtlMs: 30 * 60 * 1000, recentMs: RECENT },
    cwd: "/repo",
    now,
    env: {},
    args: parseArgs(argv, new Set(["color", "json", "full", "no-color", "staged", "upstream"])),
    out: () => {},
    err: () => {},
  };
}

test("preflight: unrelated active sessions are informational only", async () => {
  const s = await store();
  s.upsertSession({ id: "research", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);

  const result = runPreflight({ store: s, paths: ["src/app.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "clear");
  assert.equal(result.recommendation, "continue");
  assert.equal(result.unrelatedSessions.length, 1);
  assert.equal(result.conflicts.length, 0);
  s.close();
});

test("preflight: hard overlap is a user decision point", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "src/auth/**", reason: "login flow", createdAt: NOW, expiresAt: NOW + 60_000 });

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "hard");
  assert.equal(result.recommendation, "ask-user");
  assert.equal(result.conflicts[0]?.tier, "hard");
  s.close();
});

test("preflight: soft overlap from recent activity is a user decision point", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "claude-code", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addActivity({ sessionId: "other", ts: NOW, kind: "edit", target: "src/auth/login.ts", summary: "reviewed login", meta: null });

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "soft");
  assert.equal(result.recommendation, "ask-user");
  assert.equal(result.conflicts[0]?.tier, "soft");
  s.close();
});

test("preflight: soft overlap is found beyond the newest 200 activity rows", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "claude-code", idSource: "harness", pid: null, cwd: null }, NOW);
  s.upsertSession({ id: "noise", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addActivity({ sessionId: "other", ts: NOW, kind: "edit", target: "src/auth/login.ts", summary: "reviewed login", meta: null });
  for (let i = 1; i <= 201; i++) {
    s.addActivity({ sessionId: "noise", ts: NOW + i, kind: "run", target: `noise/${i}.ts`, summary: "noise", meta: null });
  }

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "soft");
  assert.equal(result.conflicts[0]?.hits[0]?.session.id, "other");
  s.close();
});

test("preflight: stale claims are treated as free", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "src/auth/**", reason: null, createdAt: NOW, expiresAt: NOW + 60_000 });

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + SESSION_TTL + 1, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "info");
  assert.equal(result.recommendation, "continue");
  assert.equal(result.stale[0]?.tier, "stale");
  s.close();
});

test("preflight: broad claims are detectable", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "**", reason: "whole repo", createdAt: NOW, expiresAt: NOW + 60_000 });

  const result = runPreflight({ store: s, paths: ["src/app.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "hard");
  assert.equal(hasBroadClaim(result.conflicts[0]!.hits[0]!), true);
  s.close();
});

test("preflight: normalized root claims are hard overlaps", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "", reason: "root", createdAt: NOW, expiresAt: NOW + 60_000 });

  const result = runPreflight({ store: s, paths: ["src/app.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "hard");
  assert.equal(hasBroadClaim(result.conflicts[0]!.hits[0]!), true);
  s.close();
});

test("preflight: unresolved identity warns when active sessions exist", async () => {
  const s = await store();
  s.upsertSession({ id: "maybe-me", harness: "unknown", idSource: "tty", pid: null, cwd: null }, NOW);

  const result = runPreflight({ store: s, paths: ["src/app.ts"], selfId: null, now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.match(result.warnings[0] ?? "", /identity is unresolved/);
  s.close();
});

test("preflight: reports all sessions with hard overlaps on the same path", async () => {
  const s = await store();
  for (const id of ["a", "b"]) {
    s.upsertSession({ id, harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
    s.addClaim({ sessionId: id, pattern: "src/auth/**", reason: id, createdAt: NOW, expiresAt: NOW + 60_000 });
  }

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.conflicts[0]?.hits.length, 2);
  s.close();
});

test("preflight: stale overlap holders are not called unrelated", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "src/auth/**", reason: null, createdAt: NOW, expiresAt: NOW + 60_000 });

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 61_000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "info");
  assert.equal(result.unrelatedSessions.length, 0);
  s.close();
});

test("preflight: recent activity under a hard overlap is not called unrelated", async () => {
  const s = await store();
  s.upsertSession({ id: "claimant", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "claimant", pattern: "src/auth/**", reason: null, createdAt: NOW, expiresAt: NOW + 60_000 });
  s.upsertSession({ id: "reviewer", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addActivity({ sessionId: "reviewer", ts: NOW, kind: "edit", target: "src/auth/login.ts", summary: "review", meta: null });

  const result = runPreflight({ store: s, paths: ["src/auth/login.ts"], selfId: "me", now: NOW + 1000, sessionTtlMs: SESSION_TTL, recentMs: RECENT });

  assert.equal(result.severity, "hard");
  assert.ok(result.conflicts.some((c) => c.tier === "soft" && c.hits.some((h) => h.session.id === "reviewer")));
  assert.equal(result.unrelatedSessions.length, 0);
  s.close();
});

test("preflight command does not refresh the caller heartbeat", async () => {
  const s = await store();
  s.upsertSession({ id: "me", harness: "test", idSource: "explicit", pid: null, cwd: null }, 1000);

  assert.equal(runCommand(ctxFor(s, "me", 1000 + 60_000, ["preflight", "src/app.ts", "--fail-on", "never"])), 0);
  assert.equal(s.getSession("me")?.lastSeen, 1000);
  s.close();
});

test("preflight json is capped unless --full is passed", async () => {
  const s = await store();
  s.upsertSession({ id: "other", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "**", reason: "whole repo", createdAt: NOW, expiresAt: NOW + 60_000 });
  const paths = Array.from({ length: 21 }, (_, i) => `src/file-${i}.ts`);

  let output = "";
  const cappedCtx = ctxFor(s, "me", NOW + 1000, ["preflight", ...paths, "--json", "--fail-on", "never"]);
  cappedCtx.out = (text) => {
    output += text;
  };
  assert.equal(runCommand(cappedCtx), 0);
  const cappedJson = JSON.parse(output) as { paths: unknown[]; conflicts: unknown[]; counts: { paths: number; conflicts: number }; truncated: { paths: number; conflicts: number } };
  assert.equal(cappedJson.counts.paths, 21);
  assert.equal(cappedJson.paths.length, 20);
  assert.equal(cappedJson.truncated.paths, 1);
  assert.equal(cappedJson.counts.conflicts, 21);
  assert.equal(cappedJson.conflicts.length, 20);
  assert.equal(cappedJson.truncated.conflicts, 1);

  output = "";
  const fullCtx = ctxFor(s, "me", NOW + 1000, ["preflight", ...paths, "--json", "--full", "--fail-on", "never"]);
  fullCtx.out = (text) => {
    output += text;
  };
  assert.equal(runCommand(fullCtx), 0);
  const fullJson = JSON.parse(output) as { paths: unknown[]; conflicts: unknown[]; truncated: { paths: number; conflicts: number } };
  assert.equal(fullJson.paths.length, 21);
  assert.equal(fullJson.conflicts.length, 21);
  assert.equal(fullJson.truncated.paths, 0);
  assert.equal(fullJson.truncated.conflicts, 0);
  s.close();
});

test("preflight json does not include ansi even when color is forced", async () => {
  const s = await store();
  let output = "";
  const ctx = ctxFor(s, "me", NOW + 1000, ["preflight", "src/app.ts", "--json", "--color", "--fail-on", "never"]);
  ctx.env = { FORCE_COLOR: "1" };
  ctx.out = (text) => {
    output += text;
  };

  assert.equal(runCommand(ctx), 0);
  assert.equal(stripAnsi(output), output);
  assert.equal(JSON.parse(output).severity, "clear");
  s.close();
});

test("preflight explicit outside-repo paths are input errors", async () => {
  const s = await store();

  assert.throws(
    () => runCommand(ctxFor(s, "me", NOW, ["preflight", "../outside.ts"])),
    (e) => e instanceof CliError && e.code === 2,
  );
  s.close();
});

test("parseNameStatus includes deleted, both sides of renames, and copy destinations", () => {
  const output = ["D", "src/old.ts", "R100", "src/from.ts", "src/to.ts", "C100", "src/source.ts", "src/copied.ts", "A", "src/new.ts", ""].join("\0");
  assert.deepEqual(parseNameStatus(output), ["src/old.ts", "src/from.ts", "src/to.ts", "src/copied.ts", "src/new.ts"]);
});
