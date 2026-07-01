import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as audit from "../src/commands/audit.ts";
import type { Ctx } from "../src/context.ts";
import { injectBlock } from "../src/instructions/block.ts";
import { openStore } from "../src/store/open.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function ctxFor(root: string, argv: string[] = ["audit"]): Promise<Ctx> {
  const home = tmpDir("weaver-home-");
  const store = await openStore(path.join(tmpDir("weaver-store-"), "s.db"));
  return {
    store,
    identity: { key: "tty:ttys001@host", source: "ancestry", label: "opencode" },
    repo: { repoId: "abc123", root, basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: root,
    now: 1_000_000,
    env: { HOME: home },
    args: parseArgs(argv, new Set(["json"])),
    out: () => {},
    err: () => {},
  };
}

test("audit summarizes retained usage and recommendations as JSON", async () => {
  const root = tmpDir("weaver-repo-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), injectBlock("# Agents\n"));
  const ctx = await ctxFor(root, ["audit", "--json"]);

  ctx.store.upsertSession(
    { id: "tty:ttys002@host", harness: "opencode", idSource: "ancestry", pid: null, cwd: root },
    ctx.now - ctx.config.sessionTtlMs - 1,
  );
  ctx.store.addClaim({
    sessionId: "tty:ttys002@host",
    pattern: "apps/backend/**",
    reason: "stale work",
    createdAt: ctx.now - ctx.config.claimTtlMs,
    expiresAt: ctx.now - 1,
  });
  ctx.store.addActivity({
    sessionId: "tty:ttys002@host",
    ts: ctx.now - 100,
    kind: "claim",
    target: "apps/backend/**",
    summary: "stale work",
    meta: null,
  });
  ctx.store.addNote({
    sessionId: "tty:ttys002@host",
    harness: "opencode",
    body: "global learning",
    path: null,
    tags: null,
    pinned: false,
    createdAt: ctx.now,
    supersedes: null,
  });

  let out = "";
  ctx.out = (s) => {
    out += s;
  };

  assert.equal(audit.run(ctx), 0);
  const parsed = JSON.parse(out) as {
    sessions: { total: number; staleUnended: number; weakIdentity: number };
    claims: { expiredOpen: number };
    notes: { current: number; pathScoped: number; tagged: number };
    setup: { projectInstructions: { present: number; total: number }; hooks: string };
    recommendations: string[];
  };
  assert.equal(parsed.sessions.total, 1);
  assert.equal(parsed.sessions.staleUnended, 1);
  assert.equal(parsed.sessions.weakIdentity, 1);
  assert.equal(parsed.claims.expiredOpen, 1);
  assert.equal(parsed.notes.current, 1);
  assert.equal(parsed.notes.pathScoped, 0);
  assert.equal(parsed.notes.tagged, 0);
  assert.deepEqual(parsed.setup.projectInstructions, { present: 1, total: 2, missing: ["CLAUDE.md"] });
  assert.equal(parsed.setup.hooks, "missing");
  assert.ok(parsed.recommendations.some((rec) => rec.includes("weak")));
  assert.ok(parsed.recommendations.some((rec) => rec.includes("--path")));

  ctx.store.close();
});

test("audit renders a concise human report", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));
  let out = "";
  ctx.out = (s) => {
    out += s;
  };

  assert.equal(audit.run(ctx), 0);
  assert.match(out, /^weaver audit/);
  assert.match(out, /sessions\s+:/);
  assert.match(out, /recommendations:/);

  ctx.store.close();
});
