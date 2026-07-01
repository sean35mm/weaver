import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as configCmd from "../src/commands/config.ts";
import { CONFIG_KEYS, loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { openStore } from "../src/store/open.ts";
import { DEFAULT_CLAIM_TTL_MS, DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "../src/store/reap.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-cfg-")), "s.db");
}

async function cmdCtx(argv: string[]): Promise<{ ctx: Ctx; output: () => string; errors: () => string }> {
  const store = await openStore(tmpDb());
  let out = "";
  let err = "";
  const ctx: Ctx = {
    store,
    identity: null,
    repo: { repoId: "abc123", root: "/repo", basis: "path" },
    config: loadConfig(store),
    cwd: "/repo",
    now: 1_000_000,
    env: {},
    args: parseArgs(argv),
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  };
  return { ctx, output: () => out, errors: () => err };
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

test("config command: lists every key with defaults, sets and reads back a value", async () => {
  const list = await cmdCtx(["config"]);
  assert.equal(configCmd.run(list.ctx), 0);
  for (const key of CONFIG_KEYS) assert.match(list.output(), new RegExp(`${key}[^\\n]*\\(default\\)`));
  list.ctx.store.close();

  const set = await cmdCtx(["config", "session_ttl_seconds", "120.7"]);
  assert.equal(configCmd.run(set.ctx), 0);
  assert.match(set.output(), /session_ttl_seconds[^\n]*120/);
  assert.equal(set.ctx.store.getMeta("session_ttl_seconds"), "120");
  assert.equal(loadConfig(set.ctx.store).sessionTtlMs, 120_000);

  set.ctx.args = parseArgs(["config", "session_ttl_seconds"]);
  assert.equal(configCmd.run(set.ctx), 0);
  assert.match(set.output(), /session_ttl_seconds[^\n]*120\n$/);
  set.ctx.store.close();
});

test("config command: rejects unknown keys and non-positive values", async () => {
  const unknown = await cmdCtx(["config", "bogus_key"]);
  assert.equal(configCmd.run(unknown.ctx), 1);
  assert.match(unknown.errors(), /unknown config key: bogus_key/);
  assert.match(unknown.errors(), /valid keys: session_ttl_seconds/);
  unknown.ctx.store.close();

  // note: a literal "-5" is eaten by the argv parser as a short flag, so the guard
  // sees zero/garbage rather than negatives through the real CLI
  for (const bad of ["0", "abc"]) {
    const invalid = await cmdCtx(["config", "session_ttl_seconds", bad]);
    assert.equal(configCmd.run(invalid.ctx), 1);
    assert.match(invalid.errors(), /positive number of seconds/);
    assert.equal(invalid.ctx.store.getMeta("session_ttl_seconds"), undefined);
    invalid.ctx.store.close();
  }
});
