import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError, clamp, isBroadGlob, normalizeKind, parseTtl, requireArg } from "../src/validate.ts";

test("parseTtl: units, fallback, bounds", () => {
  assert.equal(parseTtl("30m", 0), 30 * 60 * 1000);
  assert.equal(parseTtl("2h", 0), 2 * 60 * 60 * 1000);
  assert.equal(parseTtl("90s", 0), 90 * 1000);
  assert.equal(parseTtl(undefined, 12345), 12345);
  assert.equal(parseTtl("garbage", 999), 999);
  assert.equal(parseTtl("9999d", 0), 24 * 60 * 60 * 1000); // clamp to max
  assert.equal(parseTtl("1s", 0), 60 * 1000); // clamp to min
});

test("normalizeKind: known passes, unknown → run + warning", () => {
  assert.equal(normalizeKind("edit").kind, "edit");
  const u = normalizeKind("frobnicate");
  assert.equal(u.kind, "run");
  assert.ok(u.warning);
});

test("clamp: trims and caps length", () => {
  assert.equal(clamp("  hi  "), "hi");
  assert.equal(clamp("x".repeat(5000)).length, 4001); // 4000 + ellipsis
});

test("isBroadGlob", () => {
  assert.ok(isBroadGlob("**"));
  assert.ok(isBroadGlob("**/*"));
  assert.ok(isBroadGlob("./**/*"));
  assert.ok(isBroadGlob("/"));
  assert.ok(!isBroadGlob("src/auth/**"));
});

test("requireArg throws CliError when empty", () => {
  assert.throws(() => requireArg("", "x"), CliError);
  assert.equal(requireArg(" y ", "x"), "y");
});
