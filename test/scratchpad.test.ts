import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { commandTraits, run as runScratchpad } from "../src/commands/scratchpad.ts";
import type { Ctx } from "../src/context.ts";
import {
  MAX_SCRATCHPAD_BODY_BYTES,
  replaceMarkdownSection,
  type ScratchpadActor,
  ScratchpadConflictError,
  ScratchpadError,
  ScratchpadService,
  scanMarkdownHeadings,
} from "../src/scratchpads/service.ts";
import { openStore } from "../src/store/open.ts";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-scratchpad-")), "store.db");
}

const agent = (sessionId: string, worktreeId = "wt-a"): ScratchpadActor => ({
  kind: "agent",
  sessionId,
  harness: "test-agent",
  provenance: "test",
  worktreeId,
});

test("scratchpad service keeps canonical snapshots with optimistic revisions and provenance", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession(
    { id: "agent-a", harness: "test-agent", idSource: "explicit", pid: null, cwd: null, worktreeId: "wt-a" },
    100,
  );
  let now = 100;
  const pads = new ScratchpadService(store, () => now);

  const created = pads.create("  Release   plan  ", "# Plan\r\nfirst\r\n", agent("agent-a"));
  assert.equal(created.title, "Release plan");
  assert.equal(created.body, "# Plan\nfirst\n");
  assert.equal(created.revision, 1);
  assert.equal(created.createdAt, 100);

  now = 200;
  const appended = pads.append(created.id, "second", 1, agent("agent-a"));
  assert.equal(appended.body, "# Plan\nfirst\nsecond");
  assert.equal(appended.revision, 2);
  assert.throws(() => pads.replace(created.id, "stale", 1, agent("agent-a")), ScratchpadConflictError);

  now = 300;
  const section = pads.editSection(created.id, "Plan", "replacement", 2, agent("agent-a"));
  assert.equal(section.body, "# Plan\nreplacement");
  now = 400;
  const renamed = pads.rename(created.id, "Final plan", 3, agent("agent-a"));
  assert.equal(renamed.revision, 4);

  const history = pads.history(created.id);
  assert.deepEqual(
    history.map((revision) => revision.action),
    ["rename", "edit-section", "append", "create"],
  );
  assert.equal(history[0]?.worktreeId, "wt-a");
  assert.equal(history[0]?.actorId, "agent-a");
  assert.equal(history[0]?.provenance, "test");
  assert.equal(history[0]?.createdAt, 400);
  const activity = store.listRecentActivity(10);
  assert.ok(activity.every((row) => row.scratchpadId === created.id));
  assert.equal(activity[0]?.ts, 400);
  store.close();
});

test("human-readable full scratchpad history includes every revision body", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession(
    { id: "agent-a", harness: "test-agent", idSource: "explicit", pid: null, cwd: null, worktreeId: "wt-a" },
    100,
  );
  const pads = new ScratchpadService(store, () => 100);
  const created = pads.create("History", "# First\ncreated body", agent("agent-a"));
  pads.replace(created.id, "# Second\nupdated body\n", 1, agent("agent-a"));
  let output = "";
  const ctx: Ctx = {
    store,
    identity: null,
    callerIdentity: null,
    repo: { repoId: "repo", root: "/repo", basis: "path", worktreeId: "wt-a" },
    config: { sessionTtlMs: 5_000, claimTtlMs: 30_000, recentMs: 20_000 },
    cwd: "/repo",
    now: 101,
    env: {},
    args: parseArgs(["scratchpad", "history", String(created.id), "--full"]),
    out: (text) => (output += text),
    err: () => undefined,
  };

  assert.equal(await runScratchpad(ctx), 0);
  assert.equal(
    output,
    [
      "r2 replace [active] agent:test-agent",
      "# Second",
      "updated body",
      "",
      "r1 create [active] agent:test-agent",
      "# First",
      "created body",
      "",
    ].join("\n"),
  );
  store.close();
});

test("attachments are one-per-session/worktree, many-per-pad, and guard lifecycle", async () => {
  const store = await openStore(tmpDb());
  for (const id of ["agent-a", "agent-b"]) {
    store.upsertSession(
      { id, harness: "test-agent", idSource: "explicit", pid: null, cwd: null, worktreeId: `wt-${id}` },
      100,
    );
  }
  let now = 100;
  const pads = new ScratchpadService(store, () => now);
  const pad = pads.create("Shared", "# Work\n", agent("agent-a", "wt-agent-a"));
  const other = pads.create("Other", "", agent("agent-a", "wt-agent-a"));
  const callerA = { sessionId: "agent-a", worktreeId: "wt-agent-a" };
  const callerB = { sessionId: "agent-b", worktreeId: "wt-agent-b" };

  pads.use(other.id, callerA);
  pads.use(pad.id, callerA);
  pads.use(pad.id, callerB);
  assert.equal(store.listScratchpadAttachments(pad.id).length, 2);
  assert.equal(store.listScratchpadAttachments(other.id).length, 0);
  assert.throws(() => pads.archive(pad.id, 1, agent("agent-a", "wt-agent-a"), callerA), /other live attachment/);
  assert.equal(store.listScratchpadAttachments(pad.id).length, 2);

  store.detachScratchpad("agent-b", "wt-agent-b", ++now);
  const archived = pads.archive(pad.id, 1, agent("agent-a", "wt-agent-a"), callerA);
  assert.equal(archived.state, "archived");
  assert.equal(store.listScratchpadAttachments(pad.id).length, 0);
  const restored = pads.restore(pad.id, 2, agent("agent-a", "wt-agent-a"));
  assert.equal(restored.state, "active");

  pads.use(pad.id, callerA);
  assert.throws(() => pads.trash(pad.id, 3, agent("agent-a", "wt-agent-a"), callerA, null), /requires --reason/);
  const trashed = pads.trash(pad.id, 3, agent("agent-a", "wt-agent-a"), callerA, "superseded");
  assert.equal(trashed.state, "trash");
  assert.equal(trashed.previousState, "active");
  assert.equal(store.listScratchpadAttachments(pad.id).length, 0);
  const recovered = pads.recover(pad.id, 4, agent("agent-a", "wt-agent-a"));
  assert.equal(recovered.state, "active");
  assert.equal(pads.history(pad.id)[1]?.reason, "superseded");
  store.close();
});

test("lifecycle ignores stale attachments, detaches them atomically, and still blocks live ambiguous worktrees", async () => {
  const store = await openStore(tmpDb());
  let now = 10_000;
  for (const [id, seen, worktreeId] of [
    ["caller", now, "wt-caller"],
    ["stale", 1, "wt-stale"],
    ["ambiguous", now, null],
  ] as const) {
    store.upsertSession({ id, harness: "test-agent", idSource: "explicit", pid: null, cwd: null, worktreeId }, seen);
  }
  const pads = new ScratchpadService(store, () => now, 100);
  const pad = pads.create("Lifecycle", "", agent("caller", "wt-caller"));
  pads.use(pad.id, { sessionId: "caller", worktreeId: "wt-caller" });
  pads.use(pad.id, { sessionId: "stale", worktreeId: "wt-stale" });
  pads.use(pad.id, { sessionId: "ambiguous", worktreeId: "wt-unknown" });

  assert.throws(
    () => pads.archive(pad.id, 1, agent("caller", "wt-caller"), { sessionId: "caller", worktreeId: "wt-caller" }),
    /other live attachment/,
  );
  store.detachScratchpad("ambiguous", "wt-unknown", ++now);
  const archived = pads.archive(pad.id, 1, agent("caller", "wt-caller"), {
    sessionId: "caller",
    worktreeId: "wt-caller",
  });
  assert.equal(archived.state, "archived");
  assert.equal(store.listScratchpadAttachments(pad.id).length, 0);
  store.close();
});

test("Markdown validation normalizes line endings and rejects instead of truncating", async () => {
  assert.equal(replaceMarkdownSection("# A\nold\n## Child\nx\n# B\ny", "A", "new"), "# A\nnew\n# B\ny");
  assert.throws(() => replaceMarkdownSection("# A\nx", "missing", "new"), /heading not found/);

  const store = await openStore(tmpDb());
  const pads = new ScratchpadService(store, () => 1);
  const human: ScratchpadActor = {
    kind: "human",
    sessionId: null,
    harness: null,
    provenance: "test",
    worktreeId: "wt-a",
  };
  assert.throws(() => pads.create("x", "a".repeat(MAX_SCRATCHPAD_BODY_BYTES + 1), human), ScratchpadError);
  assert.equal(pads.list(null).length, 0);
  assert.throws(() => pads.create("x".repeat(201), "", human), /was not truncated/);
  assert.equal(pads.list(null).length, 0);
  assert.throws(() => pads.create("Release\nplan", "", human), /must be one line/);
  assert.throws(() => pads.create("Release\rplan", "", human), /must be one line/);
  assert.equal(pads.create("  Release\t  plan  ", "", human).title, "Release plan");
  store.close();
});

test("Markdown heading operations ignore ATX-looking lines inside fenced code", () => {
  const markdown = [
    "# Real",
    "before",
    "```md",
    "# Fenced backtick",
    "```",
    "~~~",
    "## Fenced tilde",
    "~~~",
    "## Child",
    "child",
    "# Next",
    "after",
  ].join("\n");
  assert.deepEqual(
    scanMarkdownHeadings(markdown).map(({ level, text }) => ({ level, text })),
    [
      { level: 1, text: "Real" },
      { level: 2, text: "Child" },
      { level: 1, text: "Next" },
    ],
  );
  assert.equal(
    replaceMarkdownSection(markdown, "Real", "replacement"),
    ["# Real", "replacement", "# Next", "after"].join("\n"),
  );
  assert.throws(() => replaceMarkdownSection(markdown, "Fenced backtick", "lost"), /heading not found/);
});

test("scratchpad dispatcher traits distinguish observers, human-or-agent writes, and agent-required use", () => {
  const args = (subcommand: string) => parseArgs(["scratchpad", subcommand]);
  assert.deepEqual(commandTraits(args("read")), {
    store: "touch",
    presence: "observer",
    writeGated: false,
    usage: true,
  });
  assert.deepEqual(commandTraits(args("create")), {
    store: "create",
    presence: "optional",
    writeGated: true,
    usage: false,
  });
  assert.deepEqual(commandTraits(args("use")), {
    store: "create",
    presence: "required",
    writeGated: true,
    usage: false,
  });
});

test("weak caller identity owns attachments without becoming revision actor metadata", async () => {
  const store = await openStore(tmpDb());
  const weak = { key: "tty:ttys001@host", source: "tty" as const, label: "unknown" };
  store.upsertSession(
    { id: weak.key, harness: weak.label, idSource: weak.source, pid: null, cwd: null, worktreeId: "wt-a" },
    1_000,
  );
  const pads = new ScratchpadService(store, () => 1_000);
  const created = pads.create("TTY owned", "body", {
    kind: "human",
    sessionId: null,
    harness: null,
    provenance: "test",
    worktreeId: "wt-a",
  });
  pads.use(created.id, { sessionId: weak.key, worktreeId: "wt-a" });
  let output = "";
  const ctx: Ctx = {
    store,
    identity: null,
    callerIdentity: weak,
    repo: { repoId: "repo", root: "/repo", basis: "path", worktreeId: "wt-a" },
    config: { sessionTtlMs: 5_000, claimTtlMs: 30_000, recentMs: 20_000 },
    cwd: "/repo",
    now: 1_001,
    env: {},
    args: parseArgs(["scratchpad", "archive", String(created.id), "--revision", "1"]),
    out: (text) => (output += text),
    err: () => undefined,
  };

  assert.equal(await runScratchpad(ctx), 0);
  assert.match(output, /archive scratchpad/);
  assert.equal(store.listScratchpadAttachments(created.id).length, 0);
  const revision = store.listScratchpadRevisions(created.id, 1)[0];
  assert.equal(revision?.actorKind, "human");
  assert.equal(revision?.actorId, null);
  assert.equal(revision?.actorHarness, null);
  store.close();
});
