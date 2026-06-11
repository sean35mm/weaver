import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, claimsByLiveHolders, formatStatus, sessionName, statusJson, who } from "../src/render.ts";
import type { ActivityRow, ClaimRow, NoteRow, SessionRow, Store } from "../src/store/store.ts";
import { createTheme, plainTheme, stripAnsi } from "../src/terminal/color.ts";

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
const activity = (sessionId: string): ActivityRow => ({
  id: 1,
  sessionId,
  ts: 900,
  kind: "note",
  target: null,
  summary: "recent note",
  meta: null,
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

test("formatStatus shows recently completed sessions", () => {
  const done = { ...session("explicit:done123456@host.local"), intent: "ship fixes", endedAt: 900 };
  const body = formatStatus(
    { sessions: [], completed: [done], claims: [], activity: [], notes: [] },
    1000,
    {} as Store,
  );
  assert.match(body, /weaver: no other active agents/);
  assert.match(body, /recently done:/);
  assert.match(body, /ship fixes/);
});

test("formatStatus colors without changing visible text", () => {
  const active = { ...session("explicit:active123456@host.local"), intent: "ship colors" };
  const data = { sessions: [active], completed: [], claims: [], activity: [], notes: [] };
  const plain = formatStatus(data, 1000, {} as Store);
  const colored = formatStatus(data, 1000, {} as Store, createTheme({ isTTY: true }));
  assert.notEqual(colored, plain);
  assert.equal(stripAnsi(colored), plain);
});

test("formatStatus truncates long session intents to the configured width", () => {
  const active = {
    ...session("explicit:active123456@host.local"),
    intent: "ship a very long terminal rendering polish change with many details",
  };
  const body = formatStatus(
    { sessions: [active], completed: [], claims: [], activity: [], notes: [] },
    1000,
    {} as Store,
    plainTheme,
    { width: 54 },
  );
  const row = body.trimEnd().split("\n")[1] ?? "";

  assert.equal(row.length <= 54, true);
  assert.match(row, /\.\.\. {3}1s ago$/);
});

test("formatStatus shows recent activity before recently completed sessions", () => {
  const holder = session("explicit:active123456@host.local");
  const done = { ...session("explicit:done123456@host.local"), intent: "ship fixes", endedAt: 900 };
  const body = formatStatus(
    { sessions: [], completed: [done], claims: [], activity: [activity(holder.id)], notes: [] },
    1000,
    { getSession: (id) => (id === holder.id ? holder : undefined) } as Store,
  );

  assert.equal(body.indexOf("recent:") < body.indexOf("recently done:"), true);
});

test("formatStatus truncates recent note activity but keeps full note body", () => {
  const holder = session("explicit:active123456@host.local");
  const longBody = "one two three four five six seven eight nine ten eleven twelve unique-tail";
  const note: NoteRow = {
    id: 1,
    sessionId: holder.id,
    harness: holder.harness,
    body: longBody,
    path: null,
    tags: null,
    pinned: false,
    createdAt: 0,
    supersedes: null,
  };
  const recent = { ...activity(holder.id), summary: longBody };
  const body = formatStatus(
    { sessions: [], completed: [], claims: [], activity: [recent], notes: [note] },
    1000,
    { getSession: (id) => (id === holder.id ? holder : undefined) } as Store,
    plainTheme,
    { width: 64 },
  );
  const lines = body.trimEnd().split("\n");
  const recentLine = lines.find((line) => line.includes(" note ")) ?? "";

  assert.match(recentLine, /\.\.\. \(see notes\)$/);
  assert.equal(recentLine.includes("unique-tail"), false);
  assert.equal(recentLine.length <= 64, true);
  assert.equal(body.includes("unique-tail"), true);
});

test("formatStatus wraps notes with continuation indentation", () => {
  const note: NoteRow = {
    id: 1,
    sessionId: null,
    harness: null,
    body: "one two three four five six seven eight nine ten eleven twelve",
    path: null,
    tags: null,
    pinned: false,
    createdAt: 0,
    supersedes: null,
  };
  const body = formatStatus(
    { sessions: [], completed: [], claims: [], activity: [], notes: [note] },
    1000,
    {} as Store,
    plainTheme,
    { width: 40 },
  );
  const lines = body.trimEnd().split("\n");

  assert.equal(lines[3], "  • one two three four five six seven");
  assert.equal(lines[4], "      eight nine ten eleven twelve");
});

test("formatStatus caps note width on wide terminals", () => {
  const note: NoteRow = {
    id: 1,
    sessionId: null,
    harness: null,
    body: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two",
    path: null,
    tags: null,
    pinned: false,
    createdAt: 0,
    supersedes: null,
  };
  const body = formatStatus(
    { sessions: [], completed: [], claims: [], activity: [], notes: [note] },
    1000,
    {} as Store,
    plainTheme,
    { width: 140 },
  );
  const noteLines = body.trimEnd().split("\n").slice(3);

  assert.equal(noteLines.length > 1, true);
  assert.equal(
    noteLines.every((line) => line.length <= 100),
    true,
  );
  assert.equal(noteLines[1]?.startsWith("      "), true);
});

test("formatStatus spaces wrapped notes apart", () => {
  const first: NoteRow = {
    id: 1,
    sessionId: null,
    harness: null,
    body: "one two three four five six seven eight nine ten eleven twelve",
    path: null,
    tags: null,
    pinned: false,
    createdAt: 0,
    supersedes: null,
  };
  const second = { ...first, id: 2, body: "short note" };
  const body = formatStatus(
    { sessions: [], completed: [], claims: [], activity: [], notes: [first, second] },
    1000,
    {} as Store,
    plainTheme,
    { width: 40 },
  );
  const lines = body.trimEnd().split("\n");

  assert.equal(lines[5], "");
  assert.equal(lines[6], "  • short note");
});
