import assert from "node:assert/strict";
import { test } from "node:test";
import { hasBlock, injectBlock, removeBlock } from "../src/instructions/block.ts";

test("inject into empty content", () => {
  const out = injectBlock("");
  assert.ok(hasBlock(out));
});

test("inject appends after existing content", () => {
  const out = injectBlock("# My project\n\nsome docs\n");
  assert.ok(out.startsWith("# My project"));
  assert.ok(out.includes("some docs"));
  assert.ok(hasBlock(out));
});

test("inject is idempotent — no duplicate block", () => {
  const once = injectBlock("# x\n");
  const twice = injectBlock(once);
  assert.equal(twice, once);
  assert.equal(once.indexOf("weaver:start"), once.lastIndexOf("weaver:start"));
});

test("remove strips the block but keeps surrounding content", () => {
  const injected = injectBlock("# x\n\ndocs\n");
  const removed = removeBlock(injected);
  assert.ok(!hasBlock(removed));
  assert.ok(removed.includes("# x"));
  assert.ok(removed.includes("docs"));
});

test("remove is a no-op without a block", () => {
  assert.equal(removeBlock("# x\n"), "# x\n");
});
