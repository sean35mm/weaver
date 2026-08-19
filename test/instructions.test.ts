import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasBlock,
  INSTRUCTION_BLOCK,
  INSTRUCTION_PROTOCOL_VERSION,
  injectBlock,
  instructionBlockStatus,
  removeBlock,
} from "../src/instructions/block.ts";

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

test("managed block status distinguishes current, outdated, missing, and foreign", () => {
  assert.equal(instructionBlockStatus(INSTRUCTION_BLOCK), "current");
  assert.equal(instructionBlockStatus(INSTRUCTION_BLOCK.replace("protocol=3", "protocol=2")), "outdated");
  assert.equal(instructionBlockStatus("# user instructions\n"), "missing");
  assert.equal(instructionBlockStatus("<!-- weaver:start protocol=1 -->\nunterminated"), "foreign");
  assert.equal(INSTRUCTION_PROTOCOL_VERSION, 3);
});

test("inject refreshes an outdated block in place without changing user text", () => {
  const old = INSTRUCTION_BLOCK.replace("protocol=3", "protocol=2").replace("scratchpads-first", "old protocol");
  const input = `# Before\n\nuser guidance\n\n${old}\n\n# After\n\nmore guidance\n`;
  const output = injectBlock(input);
  assert.equal(instructionBlockStatus(output), "current");
  assert.match(output, /^# Before\n\nuser guidance/);
  assert.match(output, /# After\n\nmore guidance\n$/);
  assert.doesNotMatch(output, /old protocol/);
});

test("inject leaves an incomplete foreign marker untouched", () => {
  const input = "# User file\n\n<!-- weaver:start custom -->\nkeep this\n";
  assert.equal(injectBlock(input), input);
  assert.equal(instructionBlockStatus(input), "foreign");
});

test("inject and remove preserve complete foreign or ambiguous marker blocks", () => {
  const custom = "# User file\n\n<!-- weaver:start custom -->\nkeep this\n<!-- weaver:end -->\n";
  assert.equal(instructionBlockStatus(custom), "foreign");
  assert.equal(injectBlock(custom), custom);
  assert.equal(removeBlock(custom), custom);

  const duplicated = `${INSTRUCTION_BLOCK}\n\n${INSTRUCTION_BLOCK}\n`;
  assert.equal(instructionBlockStatus(duplicated), "foreign");
  assert.equal(injectBlock(duplicated), duplicated);
  assert.equal(removeBlock(duplicated), duplicated);
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

test("managed lifecycle guidance distinguishes recoverable pads from full-store purge", () => {
  assert.match(INSTRUCTION_BLOCK, /no permanent per-pad/);
  assert.match(INSTRUCTION_BLOCK, /deinit --purge.*entire local store/);
});
