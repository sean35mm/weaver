import assert from "node:assert/strict";
import { test } from "node:test";
import { createTheme, stripAnsi } from "../src/terminal/color.ts";
import { padEndVisible, truncateVisible, visibleLength, wrapWithPrefix } from "../src/terminal/format.ts";

test("visibleLength and padEndVisible ignore ANSI color codes", () => {
  const text = createTheme({ isTTY: true }).accent("abc");

  assert.equal(visibleLength(text), 3);
  assert.equal(visibleLength(padEndVisible(text, 6)), 6);
  assert.equal(stripAnsi(padEndVisible(text, 6)), "abc   ");
});

test("truncateVisible preserves visible width for colored text", () => {
  const text = createTheme({ isTTY: true }).path("abcdefghijklmnopqrstuvwxyz");
  const truncated = truncateVisible(text, 10);

  assert.equal(visibleLength(truncated), 10);
  assert.equal(stripAnsi(truncated), "abcdefg...");
});

test("wrapWithPrefix aligns continuation lines by visible prefix width", () => {
  const prefix = `${createTheme({ isTTY: true }).warn("warn:")} `;
  const lines = wrapWithPrefix(prefix, "one two three four five", 18);

  assert.deepEqual(lines.map(stripAnsi), ["warn: one two", "      three four", "      five"]);
});
