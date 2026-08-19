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
  ctx.store.addCommandEvent({
    ts: ctx.now - 50,
    command: "status",
    sessionId: null,
    harness: null,
    idSource: null,
  });
  ctx.store.addCommandEvent({
    ts: ctx.now - 25,
    command: "audit",
    sessionId: "tty:ttys001@host",
    harness: "opencode",
    idSource: "ancestry",
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
  const scratchpad = ctx.store.createScratchpad({
    title: "Audit pad",
    body: "secret scratchpad body",
    createdAt: ctx.now,
  });
  ctx.store.attachScratchpad({
    scratchpadId: scratchpad.id,
    sessionId: "tty:ttys002@host",
    worktreeId: "wt-a",
    attachedAt: ctx.now,
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
    scratchpads: { total: number; active: number; archived: number; trash: number; liveAttachments: number };
    commands: { total: number; byCommand: Record<string, number>; lastSeenMsAgo: Record<string, number> };
    setup: {
      projectInstructions: { present: number; total: number };
      hooks: { project: string; global: string };
      opencodePlugin: { project: string; global: string };
    };
    recommendations: string[];
  };
  assert.equal(parsed.sessions.total, 1);
  assert.equal(parsed.sessions.staleUnended, 1);
  assert.equal(parsed.sessions.weakIdentity, 1);
  assert.equal(parsed.claims.expiredOpen, 1);
  assert.equal(parsed.notes.current, 1);
  assert.equal(parsed.notes.pathScoped, 0);
  assert.equal(parsed.notes.tagged, 0);
  assert.deepEqual(parsed.scratchpads, { total: 1, active: 1, archived: 0, trash: 0, liveAttachments: 1 });
  assert.equal(parsed.commands.total, 2);
  assert.equal(parsed.commands.byCommand.status, 1);
  assert.equal(parsed.commands.byCommand.audit, 1);
  assert.equal(parsed.commands.lastSeenMsAgo.audit, 25);
  assert.deepEqual(parsed.setup.projectInstructions, { present: 1, total: 2, missing: ["CLAUDE.md"] });
  assert.deepEqual(parsed.setup.hooks, { project: "missing", global: "missing" });
  assert.deepEqual(parsed.setup.opencodePlugin, { project: "missing", global: "missing" });
  assert.ok(parsed.recommendations.some((rec) => rec.includes("weak")));
  assert.ok(parsed.recommendations.some((rec) => rec.includes("--path")));
  assert.doesNotMatch(out, /secret scratchpad body/);

  ctx.store.close();
});

// Smoke only: the human report is presentation; the JSON test above pins the real contract.
test("audit renders a human report without crashing", async () => {
  const ctx = await ctxFor(tmpDir("weaver-repo-"));
  let out = "";
  ctx.out = (s) => {
    out += s;
  };

  assert.equal(audit.run(ctx), 0);
  assert.match(out, /^weaver audit/);

  ctx.store.close();
});
