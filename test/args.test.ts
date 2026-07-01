import assert from "node:assert/strict";
import { test } from "node:test";
import { flagBool, flagStr, parseArgs, rest } from "../src/args.ts";

test("parseArgs: positionals, value flags, and --flag=value", () => {
  const args = parseArgs(["claim", "src/auth/**", "--reason", "token work", "--ttl=30m"]);
  assert.deepEqual(args._, ["claim", "src/auth/**"]);
  assert.equal(args.flags.reason, "token work");
  assert.equal(args.flags.ttl, "30m");
});

test("parseArgs: known booleans never consume the next token", () => {
  const bools = new Set(["json", "no-touch"]);
  const args = parseArgs(["check", "--no-touch", "src/app.ts", "--json"], bools);
  assert.deepEqual(args._, ["check", "src/app.ts"]);
  assert.equal(args.flags["no-touch"], true);
  assert.equal(args.flags.json, true);
});

test("parseArgs: unknown flag is a value flag when followed by a non-flag, else boolean", () => {
  const withValue = parseArgs(["--base", "main"]);
  assert.equal(withValue.flags.base, "main");
  assert.deepEqual(withValue._, []);

  const trailing = parseArgs(["--full"]);
  assert.equal(trailing.flags.full, true);

  const beforeFlag = parseArgs(["--full", "--json"]);
  assert.equal(beforeFlag.flags.full, true);
  assert.equal(beforeFlag.flags.json, true);
});

test("parseArgs: short flags are booleans; lone dash is a positional", () => {
  const args = parseArgs(["-v", "-", "notes"]);
  assert.equal(args.flags.v, true);
  assert.deepEqual(args._, ["-", "notes"]);
});

test("parseArgs: --flag= keeps an empty string value; repeated flags keep the last", () => {
  const empty = parseArgs(["--reason="]);
  assert.equal(empty.flags.reason, "");

  const repeated = parseArgs(["--ttl", "30m", "--ttl", "2h"]);
  assert.equal(repeated.flags.ttl, "2h");
});

test("flagStr/flagBool/rest accessors", () => {
  const args = parseArgs(["note", "pg", "runs", "on", ":5433", "--pin", "--path", "db/**"], new Set(["pin"]));
  assert.equal(flagStr(args, "path"), "db/**");
  assert.equal(flagStr(args, "pin"), undefined);
  assert.equal(flagBool(args, "pin"), true);
  assert.equal(flagBool(args, "path"), false);
  assert.equal(rest(args, 1), "pg runs on :5433");
});
