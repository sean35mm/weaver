import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { openStore } from "../src/store/open.ts";
import { DEFAULT_CLAIM_TTL_MS, DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "../src/store/reap.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-cfg-")), "s.db");
}

test("loadConfig: defaults when unset", async () => {
  const store = await openStore(tmpDb());
  const c = loadConfig(store);
  assert.equal(c.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  assert.equal(c.claimTtlMs, DEFAULT_CLAIM_TTL_MS);
  assert.equal(c.recentMs, DEFAULT_RECENT_ACTIVITY_MS);
  store.close();
});

test("loadConfig: reads overrides (seconds → ms), ignores garbage", async () => {
  const store = await openStore(tmpDb());
  store.setMeta("session_ttl_seconds", "120");
  store.setMeta("claim_ttl_seconds", "0"); // invalid → default
  store.setMeta("recent_activity_seconds", "nope"); // invalid → default
  const c = loadConfig(store);
  assert.equal(c.sessionTtlMs, 120_000);
  assert.equal(c.claimTtlMs, DEFAULT_CLAIM_TTL_MS);
  assert.equal(c.recentMs, DEFAULT_RECENT_ACTIVITY_MS);
  store.close();
});
