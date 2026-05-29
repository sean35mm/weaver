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

test("glob from a subdir keeps glob tokens", () => {
  assert.equal(normalizeTarget("**/*.ts", root, "/repo/src"), "src/**/*.ts");
});

test("glob at root unchanged", () => {
  assert.equal(normalizeTarget("src/auth/**", root, "/repo"), "src/auth/**");
});

test("normalizeRemoteUrl: ssh and https forms collapse", () => {
  const https = normalizeRemoteUrl("https://github.com/Owner/Repo.git");
  const ssh = normalizeRemoteUrl("git@github.com:Owner/Repo.git");
  assert.equal(https, "github.com/owner/repo");
  assert.equal(ssh, "github.com/owner/repo");
});
