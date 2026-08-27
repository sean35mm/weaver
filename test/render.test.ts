import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsByLiveHolders, formatStatus, sessionName, statusJson, who } from "../src/render.ts";
import type { ClaimRow, ScratchpadRow, SessionRow, Store } from "../src/store/store.ts";

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

test("status rendering shows relevant pads, hides standalone pads by default, and keeps JSON redacted", () => {
  const attached = { ...session("explicit:alice@host.local"), worktreeId: "worktree-a" };
  const pad: ScratchpadRow = {
    id: 7,
    title: "Release plan",
    body: "SECRET BODY",
    state: "active",
    previousState: null,
    revision: 3,
    createdAt: 100,
    updatedAt: 900,
  };
  const standalone = { ...pad, id: 8, title: "Standalone notes" };
  const activityPad = { ...pad, id: 9, title: "Activity context" };
  const data = {
    sessions: [],
    completed: [],
    claims: [{ ...claim(attached.id), scratchpadId: pad.id }],
    activity: [
      {
        id: 1,
        sessionId: attached.id,
        ts: 950,
        kind: "edit" as const,
        target: "src/activity.ts",
        summary: null,
        meta: null,
        scratchpadId: activityPad.id,
      },
    ],
    notes: [],
    scratchpads: [standalone, activityPad, pad],
    scratchpadAttachments: [
      {
        id: 1,
        scratchpadId: pad.id,
        sessionId: attached.id,
        worktreeId: "worktree-a",
        attachedAt: 500,
        detachedAt: null,
      },
      {
        id: 2,
        scratchpadId: standalone.id,
        sessionId: "stale-session",
        worktreeId: "worktree-stale",
        attachedAt: 400,
        detachedAt: null,
      },
    ],
  };
  const store = { getSession: (id: string) => (id === attached.id ? attached : undefined) } as Store;

  const body = formatStatus(data, 1_000, store, undefined, {
    scratchpads: "relevant",
    liveAttachmentSessions: new Set([attached.id]),
  });
  assert.match(body, /#7.*Release plan.*r3/);
  assert.match(body, /#9.*Activity context.*r3/);
  assert.doesNotMatch(body, /#8.*Standalone notes/);
  assert.match(body, /claims:/);
  assert.match(body, /alice/);
  assert.doesNotMatch(body, /SECRET BODY/);

  const fullBody = formatStatus(data, 1_000, store, undefined, { scratchpads: "all" });
  assert.match(fullBody, /#7.*Release plan.*r3/);
  assert.match(fullBody, /#8.*Standalone notes.*r3/);
  assert.match(fullBody, /#9.*Activity context.*r3/);
  assert.match(fullBody, /alice/);
  assert.doesNotMatch(fullBody, /SECRET BODY/);

  const json = statusJson("repo", data, 1_000, store) as {
    claims: Array<{ scratchpadId: number | null }>;
    scratchpads: Array<Record<string, unknown> & { attachedSessions: Array<Record<string, unknown>> }>;
  };
  assert.equal(json.claims[0]?.scratchpadId, 7);
  assert.deepEqual(
    json.scratchpads.map((entry) => entry.title),
    ["Standalone notes", "Activity context", "Release plan"],
  );
  assert.ok(json.scratchpads.every((entry) => !("body" in entry)));
  assert.ok(json.scratchpads.flatMap((entry) => entry.attachedSessions).every((entry) => !("sessionId" in entry)));
  assert.match(String(json.scratchpads[2]?.attachedSessions[0]?.shortId), /^[a-f0-9]{6}$/);
});

test("relevant pad participants include visible sessions but omit self-hidden and stale attachments", () => {
  const other = session("explicit:other@host.local");
  const self = session("explicit:self@host.local");
  const stale = session("explicit:stale@host.local");
  const pad: ScratchpadRow = {
    id: 12,
    title: "Visible attachment",
    body: "SECRET",
    state: "active",
    previousState: null,
    revision: 1,
    createdAt: 100,
    updatedAt: 200,
  };
  const data = {
    sessions: [other],
    completed: [],
    claims: [],
    activity: [],
    notes: [],
    scratchpads: [pad],
    scratchpadAttachments: [
      {
        id: 1,
        scratchpadId: pad.id,
        sessionId: other.id,
        worktreeId: "worktree-other",
        attachedAt: 150,
        detachedAt: null,
      },
      {
        id: 2,
        scratchpadId: pad.id,
        sessionId: self.id,
        worktreeId: "worktree-self",
        attachedAt: 140,
        detachedAt: null,
      },
      {
        id: 3,
        scratchpadId: pad.id,
        sessionId: stale.id,
        worktreeId: "worktree-stale",
        attachedAt: 130,
        detachedAt: null,
      },
    ],
  };
  const store = {
    getSession: (id: string) => [other, self, stale].find((candidate) => candidate.id === id),
  } as Store;

  const body = formatStatus(data, 1_000, store, undefined, {
    scratchpads: "relevant",
    liveAttachmentSessions: new Set([other.id]),
  });
  assert.match(body, /#12.*Visible attachment.*r1.*other/);
  assert.doesNotMatch(body, /self|stale/);
  assert.doesNotMatch(body, /SECRET/);

  const full = formatStatus(data, 1_000, store, undefined, { scratchpads: "all" });
  assert.match(full, /#12.*Visible attachment.*r1.*other.*self.*stale/);
});
