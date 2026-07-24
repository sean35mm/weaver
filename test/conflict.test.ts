import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectConflict } from "../src/conflict.ts";
import { openStore } from "../src/store/open.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-cf-")), "s.db");
}
const NOW = 1_000_000;

test("hard: live session holds an overlapping claim", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession({ id: "other", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({
    sessionId: "other",
    pattern: "src/auth/**",
    reason: "tokens",
    createdAt: NOW,
    expiresAt: NOW + 1_000_000,
  });

  const r = detectConflict({ store: s, target: "src/auth/login.ts", selfId: "me", now: NOW + 1000 });
  assert.equal(r.tier, "hard");
  assert.equal(r.hits[0]?.session.harness, "codex");
  s.close();
});

test("known same-worktree self is excluded", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession(
    { id: "me", harness: "claude-code", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-a" },
    NOW,
  );
  s.addClaim({
    sessionId: "me",
    pattern: "src/auth/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + 1_000_000,
    worktreeId: "wt-a",
  });

  const r = detectConflict({
    store: s,
    target: "src/auth/login.ts",
    selfId: "me",
    now: NOW + 1000,
    worktreeId: "wt-a",
  });
  assert.equal(r.tier, "clear");
  s.close();
});

test("reused identity remains visible across different or unknown worktrees", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession(
    { id: "me", harness: "claude-code", idSource: "harness", pid: null, cwd: null, worktreeId: "wt-b" },
    NOW,
  );
  s.addClaim({
    sessionId: "me",
    pattern: "src/auth/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + 1_000_000,
    worktreeId: "wt-b",
  });
  s.addActivity({
    sessionId: "me",
    ts: NOW,
    kind: "edit",
    target: "src/auth/login.ts",
    summary: null,
    meta: null,
    worktreeId: "wt-b",
  });

  const different = detectConflict({
    store: s,
    target: "src/auth/login.ts",
    selfId: "me",
    now: NOW + 1,
    worktreeId: "wt-a",
  });
  assert.equal(different.tier, "clear");
  assert.equal(different.informationalHits.length, 1);
  assert.ok(different.informationalHits.every((hit) => hit.relation === "different-worktree"));

  s.addClaim({
    sessionId: "me",
    pattern: "src/legacy/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + 1_000_000,
  });
  const unknown = detectConflict({
    store: s,
    target: "src/legacy/login.ts",
    selfId: "me",
    now: NOW + 1,
    worktreeId: "wt-a",
  });
  assert.equal(unknown.tier, "hard");
  assert.equal(unknown.hits[0]?.relation, "unknown-worktree");
  s.close();
});

test("stale: claim valid but holder went stale", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession({ id: "other", harness: "codex", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addClaim({
    sessionId: "other",
    pattern: "src/auth/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + 10 * 60 * 60 * 1000,
  });

  const r = detectConflict({ store: s, target: "src/auth/x.ts", selfId: "me", now: NOW + 60 * 60 * 1000 });
  assert.equal(r.tier, "stale");
  s.close();
});

test("soft: recent activity by a live session, no claim", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession({ id: "other", harness: "opencode", idSource: "harness", pid: null, cwd: null }, NOW);
  s.addActivity({ sessionId: "other", ts: NOW, kind: "edit", target: "src/auth/login.ts", summary: "x", meta: null });

  const r = detectConflict({ store: s, target: "src/auth/login.ts", selfId: "me", now: NOW + 1000 });
  assert.equal(r.tier, "soft");
  s.close();
});

test("clear: nothing overlaps", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession({ id: "other", harness: "pi", idSource: "tty", pid: null, cwd: null }, NOW);
  s.addClaim({ sessionId: "other", pattern: "tests/**", reason: null, createdAt: NOW, expiresAt: NOW + 1_000_000 });

  const r = detectConflict({ store: s, target: "src/auth/login.ts", selfId: "me", now: NOW + 1000 });
  assert.equal(r.tier, "clear");
  s.close();
});

test("known different worktrees are informational; same and unknown remain blocking", async () => {
  const s = await openStore(tmpDb());
  s.upsertSession({ id: "other", harness: "pi", idSource: "tty", pid: null, cwd: null, worktreeId: "wt-b" }, NOW);
  s.addClaim({
    sessionId: "other",
    pattern: "src/auth/**",
    reason: null,
    createdAt: NOW,
    expiresAt: NOW + 1_000_000,
    worktreeId: "wt-b",
  });

  const different = detectConflict({
    store: s,
    target: "src/auth/x.ts",
    selfId: "me",
    now: NOW + 1,
    worktreeId: "wt-a",
  });
  assert.equal(different.tier, "clear");
  assert.equal(different.informationalHits[0]?.relation, "different-worktree");

  const same = detectConflict({ store: s, target: "src/auth/x.ts", selfId: "me", now: NOW + 1, worktreeId: "wt-b" });
  assert.equal(same.tier, "hard");
  assert.equal(same.hits[0]?.relation, "same-worktree");

  const unknown = detectConflict({ store: s, target: "src/auth/x.ts", selfId: "me", now: NOW + 1 });
  assert.equal(unknown.tier, "hard");
  assert.equal(unknown.hits[0]?.relation, "unknown-worktree");
  s.close();
});

test("mixed worktree hits remain blocking and retain informational participants", async () => {
  const s = await openStore(tmpDb());
  for (const [id, worktreeId] of [
    ["same", "wt-a"],
    ["different", "wt-b"],
  ] as const) {
    s.upsertSession({ id, harness: "pi", idSource: "tty", pid: null, cwd: null, worktreeId }, NOW);
    s.addClaim({
      sessionId: id,
      pattern: "src/auth/**",
      reason: null,
      createdAt: NOW,
      expiresAt: NOW + 1_000_000,
      worktreeId,
    });
  }
  const result = detectConflict({ store: s, target: "src/auth/x.ts", selfId: "me", now: NOW + 1, worktreeId: "wt-a" });
  assert.equal(result.tier, "hard");
  assert.equal(result.hits[0]?.session.id, "same");
  assert.equal(result.informationalHits[0]?.session.id, "different");
  s.close();
});
