import assert from "node:assert/strict";
import { test } from "node:test";
import { isStandaloneBinary } from "../src/env.ts";

test("isStandaloneBinary: the installed binary vs running from source", () => {
  assert.equal(isStandaloneBinary("/usr/local/bin/weaver"), true);
  assert.equal(isStandaloneBinary("/Users/x/.local/bin/weaver"), true);
  assert.equal(isStandaloneBinary("/usr/bin/node"), false);
  assert.equal(isStandaloneBinary("/opt/homebrew/bin/node"), false);
  assert.equal(isStandaloneBinary("/home/u/.bun/bin/bun"), false);
});
