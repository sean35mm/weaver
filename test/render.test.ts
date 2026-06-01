import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, claimsByLiveHolders } from "../src/render.ts";
import type { ClaimRow, SessionRow } from "../src/store/store.ts";

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
