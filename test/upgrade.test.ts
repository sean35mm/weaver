import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import * as upgrade from "../src/commands/upgrade.ts";
import type { Ctx } from "../src/context.ts";
import { EmptyStore } from "../src/store/empty.ts";

test("sha256Hex hashes bytes", () => {
  assert.equal(
    upgrade.sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("parseSha256 accepts checksum-file format", () => {
  const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(upgrade.parseSha256(`${hash}  weaver-linux-x64\n`), hash);
  assert.equal(upgrade.parseSha256("not-a-hash"), null);
});

test("upgrade guidance preserves prior init scope and OpenCode restart requirements", () => {
  assert.match(upgrade.INTEGRATION_REFRESH_MESSAGE, /weaver init --project/);
  assert.match(upgrade.INTEGRATION_REFRESH_MESSAGE, /weaver init --global/);
  assert.match(upgrade.INTEGRATION_REFRESH_MESSAGE, /include `--hooks`/);
  assert.match(upgrade.INTEGRATION_REFRESH_MESSAGE, /restart OpenCode/);
});

test("upgrade refuses when not running the standalone binary", async () => {
  let err = "";
  const ctx: Ctx = {
    store: new EmptyStore(),
    identity: null,
    repo: { repoId: "abc123", root: "/repo", basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: "/repo",
    now: 1_000_000,
    env: {},
    args: parseArgs(["upgrade"]),
    out: () => {},
    err: (s) => {
      err += s;
    },
  };

  assert.equal(await upgrade.run(ctx), 1);
  assert.match(err, /only applies to the standalone/);
});
