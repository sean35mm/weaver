import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIdentity } from "../src/identity/session.ts";

const host = "h";
const base = { argv: [] as string[], host };

test("explicit via WEAVER_SESSION", () => {
  const id = resolveIdentity({ ...base, env: { WEAVER_SESSION: "abc" } });
  assert.equal(id?.source, "explicit");
  assert.equal(id?.key, "explicit:abc@h");
});

test("--session flag beats env", () => {
  const id = resolveIdentity({ env: { WEAVER_SESSION: "abc" }, argv: ["--session", "xyz"], host });
  assert.equal(id?.key, "explicit:xyz@h");
});

test("explicit wins over harness env", () => {
  const id = resolveIdentity({ ...base, env: { WEAVER_SESSION: "e", CLAUDE_CODE_SESSION_ID: "h" } });
  assert.equal(id?.source, "explicit");
});

test("harness: claude-code / opencode / codex", () => {
  assert.equal(resolveIdentity({ ...base, env: { CLAUDE_CODE_SESSION_ID: "u1" } })?.key, "harness:claude-code:u1@h");
  assert.equal(resolveIdentity({ ...base, env: { OPENCODE_RUN_ID: "o1" } })?.key, "harness:opencode:o1@h");
  assert.equal(resolveIdentity({ ...base, env: { CODEX_THREAD_ID: "c1" } })?.key, "harness:codex:c1@h");
});

test("tty (self) via injected resolver", () => {
  const id = resolveIdentity({ ...base, env: {}, ttyResolver: () => ({ device: "ttys003", viaAncestry: false }) });
  assert.equal(id?.source, "tty");
  assert.equal(id?.key, "tty:ttys003@h");
});

test("tty (ancestry)", () => {
  const id = resolveIdentity({ ...base, env: {}, ttyResolver: () => ({ device: "ttys007", viaAncestry: true }) });
  assert.equal(id?.source, "ancestry");
  assert.equal(id?.key, "tty:ttys007@h");
});

test("no signal → null (never anonymous)", () => {
  const id = resolveIdentity({ ...base, env: {}, ttyResolver: () => null });
  assert.equal(id, null);
});
