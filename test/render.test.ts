import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, claimsByLiveHolders, formatStatus, statusJson } from "../src/render.ts";
import type { ClaimRow, SessionRow, Store } from "../src/store/store.ts";

const session = (id: string): SessionRow => ({
  id,
  harness: "test",
  idSource: "explicit",
  pid: null,
  cwd: null,
  intent: null,
  startedAt: 0,
  lastSeen: 0,
  endedAt: null,
});
const claim = (sessionId: string): ClaimRow => ({
  id: 0,
  sessionId,
  pattern: "x",
  reason: null,
  createdAt: 0,
  expiresAt: 0,
  releasedAt: null,
});

test("claimsByLiveHolders drops claims from non-live holders", () => {
  const live = [session("a"), session("b")];
  const claims = [claim("a"), claim("gone"), claim("b")];
  assert.deepEqual(
    claimsByLiveHolders(claims, live).map((c) => c.sessionId),
    ["a", "b"],
  );
});

test("ago formats relative time", () => {
  assert.equal(ago(5_000), "5s ago");
  assert.equal(ago(120_000), "2m ago");
  assert.equal(ago(-5), "0s ago");
});

test("statusJson redacts full session ids", () => {
  const full = "harness:opencode:abcdef123456@host.local";
  const data = { sessions: [session(full)], completed: [], claims: [], activity: [], notes: [] };
  const json = statusJson("repo", data, 1000, {} as Store) as { sessions: Array<Record<string, unknown>> };
  assert.match(String(json.sessions[0]?.shortId), /^[a-f0-9]{6}$/);
  assert.notEqual(json.sessions[0]?.shortId, "123456");
  assert.equal("id" in (json.sessions[0] ?? {}), false);
});

test("short ids do not expose short explicit session keys", () => {
  const data = { sessions: [session("explicit:abc123@host.local")], completed: [], claims: [], activity: [], notes: [] };
  const json = statusJson("repo", data, 1000, {} as Store) as { sessions: Array<Record<string, unknown>> };
  assert.notEqual(json.sessions[0]?.shortId, "abc123");
});

test("formatStatus shows recently completed sessions", () => {
  const done = { ...session("explicit:done123456@host.local"), intent: "ship fixes", endedAt: 900 };
  const body = formatStatus({ sessions: [], completed: [done], claims: [], activity: [], notes: [] }, 1000, {} as Store);
  assert.match(body, /weaver: no other active agents/);
  assert.match(body, /recently done:/);
  assert.match(body, /ship fixes/);
});
