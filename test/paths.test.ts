import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemoteUrl } from "../src/repo/identity.ts";
import { normalizeTarget } from "../src/repo/paths.ts";

const root = "/repo";

test("plain relative from repo root", () => {
  assert.equal(normalizeTarget("src/auth/login.ts", root, "/repo"), "src/auth/login.ts");
});

test("strips leading ./", () => {
  assert.equal(normalizeTarget("./src/x.ts", root, "/repo"), "src/x.ts");
});

test("relative from a subdir resolves to root-relative", () => {
  assert.equal(normalizeTarget("login.ts", root, "/repo/src/auth"), "src/auth/login.ts");
});

test("absolute path inside repo", () => {
  assert.equal(normalizeTarget("/repo/src/auth/login.ts", root, "/repo/anywhere"), "src/auth/login.ts");
});

test("absolute path outside repo is rejected", () => {
  assert.throws(() => normalizeTarget("/other/src/auth/login.ts", root, "/repo"), /inside this repo/);
});

test("glob from a subdir keeps glob tokens", () => {
  assert.equal(normalizeTarget("**/*.ts", root, "/repo/src"), "src/**/*.ts");
});

test("glob at root unchanged", () => {
  assert.equal(normalizeTarget("src/auth/**", root, "/repo"), "src/auth/**");
});

test("glob with .. from a subdir collapses to repo-relative (not src/auth/../api/**)", () => {
  assert.equal(normalizeTarget("../api/**", root, "/repo/src/auth"), "src/api/**");
});

test("non-glob with .. from a subdir collapses too", () => {
  assert.equal(normalizeTarget("../api/x.ts", root, "/repo/src/auth"), "src/api/x.ts");
});

test("relative path escaping repo is rejected", () => {
  assert.throws(() => normalizeTarget("../outside.ts", root, "/repo"), /inside this repo/);
});

test("normalizeRemoteUrl: ssh and https forms collapse", () => {
  const https = normalizeRemoteUrl("https://github.com/Owner/Repo.git");
  const ssh = normalizeRemoteUrl("git@github.com:Owner/Repo.git");
  assert.equal(https, "github.com/owner/repo");
  assert.equal(ssh, "github.com/owner/repo");
});
