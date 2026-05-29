#!/usr/bin/env node
/*
 * Weaver demo — seeds a throwaway store with a few simulated agents coordinating, then tells
 * you how to watch it live. Doubles as a manual smoke test and the launch GIF source.
 *
 *   node scripts/demo.ts        # seeds + prints how to view
 *   bun  scripts/demo.ts
 *
 * It writes to an isolated store under WEAVER_HOME (a temp dir it creates), so it never
 * touches your real ~/.weaver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRepoId } from "../src/repo/identity.ts";
import { openStore } from "../src/store/open.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-demo-"));
// Key the demo store by the SAME repo id the CLI will resolve from this cwd, so
// `WEAVER_HOME=<home> weaver watch` (run here) opens this very store.
const repoId = resolveRepoId().repoId;
const dbPath = path.join(home, `${repoId}.db`);

const store = await openStore(dbPath);
const now = Date.now();
const ago = (s: number): number => now - s * 1000;

store.setMeta("enabled", "1");

// Three agents, three harnesses, all on the same repo.
const agents = [
  { id: "harness:claude-code:demo-alice@host", harness: "claude-code", intent: "Refactor auth to route through AuthService" },
  { id: "harness:codex:demo-bob@host", harness: "codex", intent: "Add a Google OAuth provider" },
  { id: "harness:opencode:demo-cleo@host", harness: "opencode", intent: "Backfill auth unit tests" },
];
for (const a of agents) {
  store.upsertSession({ id: a.id, harness: a.harness, idSource: "harness", pid: null, cwd: "/demo" }, ago(120));
  store.setIntent(a.id, a.intent, ago(110));
  store.touchSession(a.id, ago(3));
}

store.addClaim({ sessionId: agents[0]!.id, pattern: "src/auth/**", reason: "rewriting token refresh — expect churn", createdAt: ago(110), expiresAt: now + 30 * 60 * 1000 });
store.addClaim({ sessionId: agents[2]!.id, pattern: "tests/auth/**", reason: "coverage only, won't touch src", createdAt: ago(90), expiresAt: now + 30 * 60 * 1000 });

store.addNote({ sessionId: agents[0]!.id, harness: "claude-code", body: "AuthService is the new entry point — don't call jwt.* directly", path: null, tags: "auth", pinned: true, createdAt: ago(80), supersedes: null });
store.addNote({ sessionId: agents[2]!.id, harness: "opencode", body: "integration tests need `docker compose up pg` on :5433", path: null, tags: "testing", pinned: false, createdAt: ago(60), supersedes: null });

const events: Array<[string, string, string, string]> = [
  [agents[0]!.id, "edit", "src/auth/login.ts", "extracted refreshToken() into AuthService"],
  [agents[2]!.id, "create", "tests/auth/session.test.ts", "added session-expiry coverage"],
  [agents[1]!.id, "create", "src/auth/providers/google.ts", "scaffolded GoogleOAuthProvider"],
  [agents[0]!.id, "run", "", "ran `npm test auth` → 3 failing on session expiry"],
];
events.forEach(([sid, kind, target, summary], i) => {
  // @ts-ignore - kind is a known ActivityKind in the demo data
  store.addActivity({ sessionId: sid, ts: ago(40 - i * 8), kind, target: target || null, summary, meta: null });
});

store.close();

process.stdout.write(`Weaver demo seeded ✦\n\n`);
process.stdout.write(`  WEAVER_HOME=${home}\n\n`);
process.stdout.write(`View it live (in this repo's directory):\n`);
process.stdout.write(`  WEAVER_HOME=${home} node src/cli.ts watch\n`);
process.stdout.write(`  WEAVER_HOME=${home} node src/cli.ts dashboard\n\n`);
process.stdout.write(`(the demo store is isolated; delete with: rm -rf ${home})\n`);
