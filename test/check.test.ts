import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as check from "../src/commands/check.ts";
import type { Ctx } from "../src/context.ts";
import { openStore } from "../src/store/open.ts";
import { DEFAULT_CLAIM_TTL_MS, DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "../src/store/reap.ts";
import type { IdSource, Store } from "../src/store/store.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-check-")), "s.db");
}

function ctxFor(store: Store, idKey: string | null, now: number, argv: string[]): Ctx {
  return {
    store,
    identity: idKey ? { key: idKey, source: "explicit" as IdSource, label: "test" } : null,
    repo: { repoId: "r", root: "/repo", basis: "path" },
    config: {
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      claimTtlMs: DEFAULT_CLAIM_TTL_MS,
      recentMs: DEFAULT_RECENT_ACTIVITY_MS,
    },
    cwd: "/repo",
    now,
    env: {},
    args: parseArgs(argv),
    out: () => {},
    err: () => {},
  };
}

test("check refreshes an existing live session's heartbeat", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "me", harness: "x", idSource: "explicit", pid: null, cwd: null }, 1000);
  const later = 1000 + 60_000;
  check.run(ctxFor(store, "me", later, ["check", "src/a.ts"]));
  assert.equal(store.getSession("me")?.lastSeen, later);
  store.close();
});

test("check --no-touch does not refresh an existing live session's heartbeat", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "me", harness: "x", idSource: "explicit", pid: null, cwd: null }, 1000);
  check.run(ctxFor(store, "me", 1000 + 60_000, ["check", "src/a.ts", "--no-touch"]));
  assert.equal(store.getSession("me")?.lastSeen, 1000);
  store.close();
});

test("check never creates a session for an unregistered caller", async () => {
  const store = await openStore(tmpDb());
  check.run(ctxFor(store, "ghost", 2000, ["check", "src/a.ts"]));
  assert.equal(store.getSession("ghost"), undefined);
  store.close();
});

test("check does not revive an ended session", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "me", harness: "x", idSource: "explicit", pid: null, cwd: null }, 1000);
  store.endSession("me", 1500);
  check.run(ctxFor(store, "me", 5000, ["check", "src/a.ts"]));
  assert.notEqual(store.getSession("me")?.endedAt, null); // still ended
  store.close();
});
