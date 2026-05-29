import assert from "node:assert/strict";
import { test } from "node:test";
import { globsOverlap, matchesPath, targetsOverlap } from "../src/glob.ts";

test("matchesPath: precise glob → path", () => {
  assert.ok(matchesPath("src/auth/**", "src/auth/login.ts"));
  assert.ok(!matchesPath("src/auth/**", "src/api/users.ts"));
  assert.ok(matchesPath("**/*.ts", "src/a/b.ts"));
});

test("globsOverlap: prefix containment, biased to true", () => {
  assert.ok(globsOverlap("src/auth/**", "src/auth/oauth/**"));
  assert.ok(globsOverlap("src/**", "src/auth/**"));
  assert.ok(globsOverlap("**", "anything/at/all/**"));
  assert.ok(!globsOverlap("src/auth/**", "src/api/**"));
});

test("targetsOverlap: path vs glob in both directions", () => {
  assert.ok(targetsOverlap("src/auth/login.ts", "src/auth/**"));
  assert.ok(targetsOverlap("src/auth/**", "src/auth/login.ts"));
  assert.ok(!targetsOverlap("src/api/x.ts", "src/auth/**"));
  assert.ok(targetsOverlap("a/b.ts", "a/b.ts"));
  assert.ok(!targetsOverlap("a/b.ts", "a/c.ts"));
});
