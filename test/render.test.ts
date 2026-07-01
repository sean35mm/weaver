import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsByLiveHolders, formatStatus, sessionName, statusJson, who } from "../src/render.ts";
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

test("statusJson redacts full session ids", () => {
  const full = "harness:opencode:abcdef123456@host.local";
  const data = { sessions: [session(full)], completed: [], claims: [], activity: [], notes: [] };
  const json = statusJson("repo", data, 1000, {} as Store) as { sessions: Array<Record<string, unknown>> };
  assert.match(String(json.sessions[0]?.shortId), /^[a-f0-9]{6}$/);
  assert.notEqual(json.sessions[0]?.shortId, "123456");
  assert.equal("id" in (json.sessions[0] ?? {}), false);
});

test("explicit sessions display the chosen name; harness sessions keep harness#hash", () => {
  const explicit = session("explicit:alice@host.local");
  assert.equal(sessionName(explicit), "alice");
  assert.equal(who(explicit), "alice");
  const harness: SessionRow = { ...session("harness:opencode:o1@h"), idSource: "harness", harness: "opencode" };
  assert.equal(sessionName(harness), "opencode");
  assert.match(who(harness), /^opencode#[a-f0-9]{6}$/);
});

test("formatStatus and statusJson surface explicit names even when harness is unknown", () => {
  const s: SessionRow = { ...session("explicit:alice@host.local"), harness: "unknown" };
  const data = { sessions: [s], completed: [], claims: [], activity: [], notes: [] };
  const body = formatStatus(data, 1000, {} as Store);
  assert.match(body, /alice/);
  assert.doesNotMatch(body, /unknown#/);
  const json = statusJson("repo", data, 1000, {} as Store) as { sessions: Array<Record<string, unknown>> };
  assert.equal(json.sessions[0]?.name, "alice");
});

test("short ids do not expose short explicit session keys", () => {
  const data = {
    sessions: [session("explicit:abc123@host.local")],
    completed: [],
    claims: [],
    activity: [],
    notes: [],
  };
  const json = statusJson("repo", data, 1000, {} as Store) as { sessions: Array<Record<string, unknown>> };
  assert.notEqual(json.sessions[0]?.shortId, "abc123");
});
