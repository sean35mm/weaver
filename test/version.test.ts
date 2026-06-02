import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/version.ts";

test("VERSION reads package.json version for source builds", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
