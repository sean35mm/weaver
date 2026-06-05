import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { createTheme, stripAnsi } from "../src/terminal/color.ts";

const BOOL = new Set(["color", "no-color"]);
const hasAnsi = (text: string): boolean => /\x1b\[[0-9;]*m/.test(text);

test("terminal colors are disabled without a TTY by default", () => {
  const theme = createTheme({ isTTY: false });
  assert.equal(theme.accent("x"), "x");
  assert.equal(theme.enabled, false);
});

test("terminal colors can be forced with flags or env", () => {
  assert.ok(hasAnsi(createTheme({ args: parseArgs(["status", "--color"], BOOL), isTTY: false }).accent("x")));
  assert.ok(hasAnsi(createTheme({ env: { FORCE_COLOR: "1" }, isTTY: false }).accent("x")));
});

test("terminal colors respect no-color controls", () => {
  assert.equal(createTheme({ args: parseArgs(["status", "--no-color"], BOOL), env: { FORCE_COLOR: "1" }, isTTY: true }).accent("x"), "x");
  assert.equal(createTheme({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: true }).accent("x"), "x");
  assert.equal(createTheme({ env: { TERM: "dumb" }, isTTY: true }).accent("x"), "x");
});

test("stripAnsi removes terminal color escapes", () => {
  const colored = createTheme({ args: parseArgs(["status", "--color"], BOOL), isTTY: false }).warn("careful");
  assert.ok(hasAnsi(colored));
  assert.equal(stripAnsi(colored), "careful");
});
