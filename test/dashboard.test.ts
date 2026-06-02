import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parsePort } from "../src/commands/dashboard.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { openStore } from "../src/store/open.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dash-")), "s.db");
}

test("serves the page and a live SSE snapshot", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession({ id: "s1", harness: "codex", idSource: "harness", pid: null, cwd: null }, Date.now());
  const srv = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0, pollMs: 200 });

  const page = await fetch(srv.url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("Weaver"));

  const res = await fetch(`${srv.url}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.ok(chunk.startsWith("data:"));
  assert.ok(chunk.includes("codex"));
  await reader.cancel();

  await srv.close();
  store.close();
});

test("404 on unknown paths", async () => {
  const store = await openStore(tmpDb());
  const srv = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  const res = await fetch(`${srv.url}/nope`);
  assert.equal(res.status, 404);
  await res.text();
  await srv.close();
  store.close();
});

test("parsePort rejects invalid values", () => {
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort("0"), 0);
  assert.equal(parsePort("65535"), 65535);
  assert.throws(() => parsePort("-1"), /between 0 and 65535/);
  assert.throws(() => parsePort("1.5"), /between 0 and 65535/);
  assert.throws(() => parsePort("65536"), /between 0 and 65535/);
});
