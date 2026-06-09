import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSha256, sha256Hex } from "../src/commands/upgrade.ts";

test("sha256Hex hashes bytes", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("parseSha256 accepts checksum-file format", () => {
  const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(parseSha256(`${hash}  weaver-linux-x64\n`), hash);
  assert.equal(parseSha256("not-a-hash"), null);
});
