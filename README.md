# Weaver

> **Shared context for your coding agents.**
> *context* — from Latin *con-* ("together") + *texere* ("to weave"). Weaver weaves the
> separate contexts of your agents into one shared fabric.

Weaver is a **CLI-first, serverless coordination layer** for multiple AI coding agents
working in the same repository at the same time. When you have Claude Code in one window,
Codex in another, and OpenCode in a third — all editing the same project — they are
normally blind to each other. They edit the same files, redo each other's work, and share
no picture of what's going on. Weaver gives every agent a fast, local way to see who else
is active, what they're working on, what they're touching, and what they've learned.

---

## Table of contents

- [The problem](#the-problem)
- [What Weaver is](#what-weaver-is)
- [Mental model](#mental-model)
- [How it works (new-user flow)](#how-it-works-new-user-flow)
- [Architecture](#architecture)
- [Identity model](#identity-model)
- [Data model](#data-model)
- [Commands](#commands)
- [The injected instruction block](#the-injected-instruction-block)
- [Conflict model](#conflict-model)
- [Visualization](#visualization)
- [What Weaver is NOT](#what-weaver-is-not)
- [Security & privacy](#security--privacy)
- [Roadmap](#roadmap)
- [Open-core / business](#open-core--business)
- [Naming](#naming)
- [License & contributing](#license--contributing)

---

## The problem

Running multiple coding agents on one codebase is now common, but every agent is an
island:

- **Different harnesses** (Claude Code, Codex, OpenCode, Cursor) don't share state.
- **Different sessions of the same harness** don't share state either — two Codex windows
  know nothing about each other.
- The result: agents **stomp each other's files**, **duplicate work**, **undo** each
  other's changes, and have **no shared picture** of the project's in-flight state.

The pain is sharpest exactly when you're most productive — when you've fanned out several
agents to work in parallel.

## What Weaver is

A single, fast CLI (`weaver`) that any agent can call from a shell. It maintains a small,
local, shared store of **who is working on what** in a repo, and it gives agents a simple
protocol to:

- **announce** what they're doing (presence + intent),
- **claim** the areas they'll touch (advisory, never enforced),
- **check** whether anyone else is in an area before editing it,
- **note** durable learnings about the codebase, and
- **log** what they actually did.

It is deliberately **not** a server, **not** an MCP, and **not** a daemon. It's a CLI over a
local SQLite file — the one interface every agent and harness already understands: bash.

## Mental model

Think of Weaver as a **shared whiteboard in a team room**, not a chat protocol. Agents
glance at the board when they walk in, post what they're working on, and check it before
grabbing a file. This is **stigmergy** — coordination *through the shared environment*
rather than direct messaging — which is exactly why a passive store (no daemon) is enough.

Everything reduces to four primitives:

| Primitive    | What it is                              | Example                                              |
| ------------ | --------------------------------------- | ---------------------------------------------------- |
| **Presence** | who's active right now, on what intent  | `claude-code · "refactor auth"` (tty:003), 10s ago   |
| **Claims**   | soft, advisory locks on paths/areas     | `claude-code claims src/auth/** — "rewriting tokens"`|
| **Notes**    | durable learnings/decisions, repo-scoped| `"integration tests need docker pg on :5433"`        |
| **Activity** | time-ordered log of what happened       | `codex edited src/api/users.ts — "added pagination"` |

## How it works (new-user flow)

**1. Install (once per machine).** Runtime-agnostic:

```bash
npm i -g @scope/weaver      # or: bun add -g @scope/weaver
# or a single static binary:  curl -fsSL https://<gh-user>.github.io/weaver/install.sh | sh
```

**2. Enable on a project (once per repo).**

```bash
cd ~/code/myapp
weaver init
```

`init` resolves the repo's identity, creates the store at `~/.weaver/<repo-id>.db`, and
appends a short, fenced instruction block to **`CLAUDE.md` and `AGENTS.md`** so every
harness learns the commands. That's the entire setup.

**3. Now what?** As the human: **nothing.** Because the instruction files now describe
Weaver, the *agents themselves* run the commands as they work — agent-facing commands
register presence, while observer commands like `status`, `activity`, `dashboard`, and
`watch` do not make the human look like an active agent. Your only active role is
**observing and occasionally intervening**.

> **Honest caveats (v1):**
> - Because v1 is CLI-first with no hooks, this relies on agents *following* the instruction
>   block. They're good at it but not perfect.
> - Awareness is **point-in-time, not continuous**: an agent reads the picture at the start
>   of a task, so changes other agents make *mid-task* aren't seen until it checks again.
>
> A future hooks layer addresses this more reliably: the optional `SessionStart` hook (v1.1)
> improves startup awareness, while later `PreToolUse` hooks are needed for mid-task edits —
> see [Roadmap](#roadmap).

**4. Observe.**

```bash
weaver status            # live picture: who's active, claims, recent activity, top notes
weaver notes             # durable learnings
weaver activity          # recent activity feed
weaver dashboard         # real-time web visualization (opens browser)
weaver watch             # live terminal TUI
```

**5. Turn it off — at four granularities.**

```bash
weaver done              # end MY session (presence + claims)
weaver disable           # pause agent writes for this project (reads still inspect)
weaver enable            # resume
weaver deinit            # remove instruction block from CLAUDE.md/AGENTS.md (--purge to drop the DB)
npm rm -g @scope/weaver  # uninstall entirely
```

## Architecture

```
   ┌────────────────────────────────────────────────────────────┐
   │  Agents (any harness, any session) — coordinate via bash     │
   │                                                              │
   │  claude-code (tty:003) ─┐                                    │
   │  codex      (tty:007) ──┼──►  `weaver <verb> …`  (fast CLI)  │
   │  opencode   (tty:011) ─┘            │                        │
   └─────────────────────────────────────┼────────────────────────┘
                                          ▼
                          ~/.weaver/<repo-id>.db   (SQLite, WAL)
                                          ▲
                                          │ read-only
                          weaver dashboard / watch  (human viewer)
```

- **Serverless.** No daemon, no background process. Each `weaver` invocation opens the
  SQLite file, performs tiny local store operations, and exits. The CLI is designed to be
  fast and quiet, without promising that Node/Bun process startup is single-digit-ms.
- **Keyed by repo identity.** The store is global, at `~/.weaver/<repo-id>.db`, where
  `<repo-id>` is derived from the git remote URL (→ falls back to the root-commit hash →
  falls back to a hash of the directory path). This means **every window *and* every git
  worktree of the same logical repo share one commons.**
- **Concurrency.** SQLite in WAL mode safely handles concurrent writes from many agent
  processes. Writes are tiny and append-mostly, so there is effectively no contention.
- **Liveness is lazy.** There's no daemon to expire stale sessions. Agent-facing commands
  bump the caller's `last_seen`; observer commands do not create or refresh sessions. Reads
  filter out anything past a TTL (~5 min) and treat expired claims as free. The store is
  self-healing at read time.
- **Storage is behind an interface.** A thin `Store` abstraction means the SQLite backend
  could later be swapped (e.g., for a graph backend) without touching the verbs.

## Identity model

A "participant" in the commons is a **session**, not a tool. Seven sessions (say 2×
Claude Code + 2× OpenCode + 3× Codex) on one repo are **seven participants**, and each must
see the other six. Harness brand is only a *label*.

The Phase-0 spike — run inside a real harness *as a tool call* — shaped this. The immediate
`weaver` process often has **no controlling TTY** (the harness pipes stdio and drops the
controlling terminal), but harnesses **expose a stable per-session UUID via env** (e.g.
`CLAUDE_CODE_SESSION_ID`), and the TTY is still recoverable by **walking the process
ancestry**. So v1 resolves identity in this order:

1. **Explicit override** — `--session <id>` / `WEAVER_SESSION`. For tests, headless runs, and
   an always-available escape hatch.
2. **Harness-native session id** — a stable per-session env var. Confirmed registry (Phase 0):
   `CLAUDE_CODE_SESSION_ID` (Claude Code), `OPENCODE_RUN_ID` (OpenCode), `CODEX_THREAD_ID`
   (Codex). **The most reliable signal on the agent tool-call path, and inherently unique per
   session** — three Codex sessions get three keys. (Codex runs in a seatbelt sandbox with no
   TTY/ancestry visibility, so for it the env id is the *only* viable signal — which is why
   this rank sits above TTY.)
3. **Controlling TTY (self → nearest ancestor)** — for a human running `weaver` directly, or a
   harness with no session env var (e.g. **Pi**, which exposes only a `PI_CODING_AGENT`
   marker); found by walking the process tree to the first real tty (not `stdout.isTTY`, since
   stdio may be piped).
4. **None → graceful fail.** No anonymous fallback: observer reads and `check` still work;
   session-mutating commands exit with a concise hint to set `WEAVER_SESSION`.

- **Identity is stored as a structured record** — `{ key, source: "explicit" | "harness" |
  "tty" | "ancestry", label }` — and the key is namespaced by source/harness so two harnesses
  can never collide. New sources can be added behind the single `resolveSessionKey()` seam
  without a schema change.

## Data model

SQLite tables (illustrative DDL; the `★` fields carry the human-readable, agent-written
descriptiveness that makes the picture useful):

```sql
-- one row per participant identity (reads decide whether it is currently live)
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,   -- stable session key, e.g. "tty:/dev/ttys003@host"
  harness     TEXT NOT NULL,      -- 'claude-code' | 'codex' | 'opencode' | 'unknown'
  id_source   TEXT NOT NULL,      -- 'explicit' | 'harness' | 'tty' | 'ancestry'
  pid         INTEGER,
  cwd         TEXT,               -- working dir / worktree path
  intent      TEXT,               -- ★ high-level goal: "Refactor auth to use AuthService"
  started_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,   -- heartbeat → drives staleness/TTL
  ended_at    INTEGER             -- set by `weaver done`; NULL = still active
);

-- advisory, TTL'd locks on file globs / areas (co-claims allowed)
CREATE TABLE claims (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  pattern     TEXT NOT NULL,      -- ★ what area: 'src/auth/**'
  reason      TEXT,               -- ★ WHY: "rewriting token refresh — expect churn"
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- TTL; refreshed on activity
  released_at INTEGER             -- NULL = active
);

-- durable, repo-scoped learnings (survive sessions & context compaction)
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id),   -- author (nullable; note outlives author)
  harness     TEXT,
  body        TEXT NOT NULL,      -- ★ "AuthService is the new entry point — don't call jwt.* directly"
  path        TEXT,               -- optional: note attached to a file/area
  tags        TEXT,               -- optional: 'testing,db'
  pinned      INTEGER DEFAULT 0,  -- surface prominently in status
  created_at  INTEGER NOT NULL,
  supersedes  INTEGER REFERENCES notes(id)    -- a note can update an older one
);

-- write-once-until-retention stream of what actually happened
CREATE TABLE activity (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,      -- 'edit'|'create'|'delete'|'run'|'claim'|'release'|'task'|'note'|'join'|'done'
  target      TEXT,               -- ★ exact path/area touched: 'src/auth/login.ts'
  summary     TEXT,               -- ★ prose: "extracted refreshToken() into AuthService"
  meta        TEXT                -- json: {"tool":"Edit","+lines":40,"-lines":12}
);

-- config/state
CREATE TABLE weaver_meta (key TEXT PRIMARY KEY, value TEXT);
  -- 'schema_version', 'enabled' (disable/enable flag), 'repo_id', 'ttl_seconds'
```

A derived **"files currently in play"** view (active `claims` + recent `activity` grouped
by normalized repo-root-relative path) powers `status` and the dashboard — no extra table
required.

**Retention:** `activity` is write-once until **lazy retention pruning** — on write, events
beyond a cap (last N events / last X days) are dropped — so the store stays small over time.
Released/expired claims can be pruned after they are no longer useful. `sessions` rows are
kept as small identity records while referenced by claims, notes, or activity, avoiding
orphaned history.

## Commands

| Command                              | Who runs it      | What it does                                  |
| ------------------------------------ | ---------------- | --------------------------------------------- |
| `weaver init`                        | you, once/repo   | create store + inject instruction block       |
| `weaver status [--json]`             | you & agents     | the current picture                            |
| `weaver task "…"`                    | agents           | announce/update intent                         |
| `weaver claim '<glob>' --reason "…"` | agents           | stake out an area and surface overlaps         |
| `weaver release '<glob>'`            | agents           | free an area                                   |
| `weaver check <path>`                | agents           | "is anyone on this?" → exit 0 clear / 1 conflict|
| `weaver note "…"` / `weaver notes`   | agents & you     | write / list durable learnings                 |
| `weaver log <kind> <path> "…"`       | agents           | record an activity event                       |
| `weaver activity`                    | you              | recent activity feed                           |
| `weaver dashboard` / `weaver watch`  | you              | live visualization (web / TUI)                 |
| `weaver done`                        | agents & you     | end a session, release its claims              |
| `weaver disable` / `weaver enable`   | you              | pause / resume Weaver for this project          |
| `weaver deinit [--purge]`            | you              | remove instruction block (and optionally DB)   |
| `weaver doctor`                      | you              | print resolved session key + source, repo-id, store path, runtime/binding — for debugging |

Read commands support `--json` for machine consumption. `status` is **silent when there's
nothing relevant**: no other live sessions, no active claims, no pinned notes, and no recent
relevant activity. It **caps its output** (top-N recent activity, truncated summaries) to
keep agent token cost near zero; pass `--full` for everything.

## The injected instruction block

`weaver init` writes this fenced block into `CLAUDE.md` and `AGENTS.md`. It is intentionally
tight (~200 tokens), reflex-forming, and self-disabling. **This is the most important
artifact in the CLI-first model — it is the entire activation mechanism — and it is expected
to be tuned heavily based on real agent behavior.**

```markdown
<!-- weaver:start — managed by Weaver; re-run `weaver init` to update, `weaver deinit` to remove -->
## Weaver — shared agent context

Other agents may be working in this repo right now. Weaver is a local CLI that keeps you
aware of them. If the `weaver` command isn't found, ignore this section.

**Do these every task (high value, low effort):**
- **At the start:** run `weaver status` to see who's active, their intent, claimed areas,
  and notes; then `weaver task "<your goal>"`.
- **Claim the area you'll work in, once:** `weaver claim '<glob>' --reason "<why>"`
  (e.g. `weaver claim 'src/auth/**' --reason "refactoring token flow"`).
- **Record durable learnings** about this repo (gotchas, conventions, "X breaks Y"):
  `weaver note "<learning>"`.
- **When finished:** `weaver done`.

**On a conflict** (`status`/`claim` shows another *live* session in your area): read their
intent + reason + recent activity, then — (1) prefer to work elsewhere and re-check later;
(2) if the overlap is harmless, proceed; (3) if you're blocked, `weaver note` your intent
and **ask the user how to split the work**. Never silently edit over another agent's active
area.

**Optional (when useful):** `weaver check <path>` before touching a file you're unsure
about; `weaver log <kind> <path> "<summary>"` after a notable change so others see it.

Keep reasons/notes short and specific — other agents read them to coordinate.
<!-- weaver:end -->
```

## Conflict model

**Weaver never blocks an edit. It surfaces; the agent decides.** Enforcement would fight the
agent and break the CLI-first flow.

**Detection — three tiers** (with glob *intersection/containment* matching, so
`src/auth/login.ts` correctly matches a `src/auth/**` claim):

| Tier      | Condition                                                            | Severity                |
| --------- | ------------------------------------------------------------------- | ----------------------- |
| **Hard**  | path matches an **active claim** held by a different, live session  | ⚠️ coordinate first     |
| **Soft**  | no claim, but a live session's **recent activity** touched the area | 👀 heads-up             |
| **Stale** | a claim exists but its holder is past TTL / expired                 | ℹ️ treat as free        |
| **Clear** | nothing matches (or it's your own session)                          | ✅ proceed              |

**Surfacing.** `weaver check` returns a non-zero exit code plus the *context* needed to
decide — the other session's intent, claim reason, recent activity, and relevant notes — not
just "denied." `weaver claim` also surfaces overlapping live claims: because claims are
advisory, it records the co-claim, prints the same context, and exits non-zero so the agent
stops and coordinates instead of silently proceeding.

**Resolution playbook** (encoded in the instruction block):

```
1. READ the context (intent + reason + recent activity + notes).
2. Can I do OTHER useful work that doesn't overlap?  → reroute, re-check later. (default)
3. Is the overlap benign (different files)?          → proceed, but `weaver log` it.
4. Blocked & need it?  → `weaver note` intent, then ASK THE USER how to split.
5. NEVER silently stomp. Always record activity.
```

**Claim model: advisory / co-claims.** Overlapping claims are *allowed* and surfaced; agents
resolve socially, with the human as arbiter. No exclusive locking (avoids deadlocks and
claim races). An opt-in `--exclusive` may come later.

**Edge cases:** a crashed agent's claim auto-expires via TTL and is treated as free on reads;
simultaneous claims both persist and each side sees the other on next read; re-claiming your
own area just refreshes the TTL. The dashboard is read-only in v1, so manual cleanup of
another session's claim is a future admin command rather than a dashboard action.

## Visualization

```bash
weaver dashboard      # aliases: weaver view / weaver ui
```

Spins up a **tiny local web server** (e.g. `127.0.0.1:7777`), opens your browser, and
renders a **live** view of the commons: a lane/card per active session (harness, intent,
TTY, heartbeat), the claim map (which globs are held by whom), a streaming activity
timeline, and the notes panel. It updates in real time by polling the SQLite store (~1s) and
pushing changes via SSE, and runs in the foreground until `Ctrl-C`.

**This does not violate the serverless principle:** the web server is purely a *human
viewer*. Agents never talk to it; they only ever touch the SQLite file. The dashboard is a
read-only window onto that same file, launched on demand. `weaver watch` is a terminal-native
equivalent for the no-browser crowd.

## What Weaver is NOT

- **Not a version-control system / merge tool.** Weaver is coordination *metadata*. It
  prevents and warns *before* an edit; it does not merge file contents. If agents ignore the
  warnings and edit the same file, that's a normal git situation — git remains the source of
  truth for actual code.
- **Not an MCP server.** It's a CLI, by design — the universal interface every harness can
  call without protocol setup.
- **Not a daemon / background service.** Each invocation is a short-lived process over a
  local file.
- **Not a cloud service** (in v1). The free, open-source core is fully local and complete for
  single-machine, multi-window use.

## Security & privacy

- **Local-only.** The store lives at `~/.weaver/` on your machine. Nothing is sent anywhere
  in v1 (cross-machine sync is an explicit, opt-in future feature).
- **Dashboard is loopback-only.** The visualization server binds to `127.0.0.1` and is not
  reachable from the network.
- **Don't put secrets in notes/intents.** The store is plaintext SQLite; treat it like any
  other local working file. Agents are instructed to keep notes short and non-sensitive.
- **Instruction block is committed on purpose.** `init` writes a fenced block into
  `CLAUDE.md`/`AGENTS.md`, which are normally committed — that's intentional (teammates'
  agents pick it up too). It contains no secrets, only usage guidance.

## Roadmap

**v1.1 (fast follow):** an **optional `SessionStart`-only hook** for Claude Code. It's the
cheapest possible hook — a one-time context injection when a session begins, no per-edit or
per-prompt cost — and it improves startup awareness by giving every new session a fresh
picture automatically. It does **not** solve mid-task conflicts by itself; agents still need
to re-check risky areas until a later `PreToolUse` hooks layer exists. Opt-in via
`weaver init --hooks=session`. Core v1 stays pure-CLI; this is the first reliability upgrade.

Then, **out of scope for v1**, in rough priority order:

1. **Full hooks layer (opt-in automation).** Thin per-harness adapters so awareness becomes
   fully automatic instead of relying on agent compliance. Designed to be cheap: hook only
   meaningful, low-frequency events (`SessionStart`, `PreToolUse` on edits, `PostToolUse` on
   edits, `Stop`), **never `UserPromptSubmit`**, and stay silent when there's no conflict so
   token cost is ~0 in the common case. Tiered via `weaver init --hooks=minimal|full`.
2. **Cross-machine sync.** A relay so agents on different machines (or teammates) share one
   commons — the natural seam for a paid/hosted offering.
3. **Dashboard "pro."** History/audit, org-wide shared notes, actionable controls.
4. **Full identity ladder.** Process ancestry for headless/sandboxed agents that cannot use
   TTY identity and should not require a manual explicit session ID.
5. **Optional graph backend** behind the existing `Store` interface, if a richer semantic
   knowledge graph becomes valuable.

## Open-core / business

- **Open-source core (free, local):** everything in v1 — the complete single-machine,
  multi-window experience, which is the primary pain.
- **Paid (later):** cross-*machine* sync, hosted dashboard with history/audit, org-wide
  knowledge. The seam is clean: the moment coordination must cross a machine boundary, you
  need a relay — and that's the product.

## Naming

*context* = Latin *con-* ("together") + *texere* ("to weave"). **Weaver** weaves your agents'
separate contexts into one fabric. (It's also a nod to the Dota 2 hero.) The bare npm name
`weaver` is held by an abandoned 2016 package, so the package ships **scoped**
(`@<scope>/weaver`) while the GitHub repo, the binary, and the brand are all simply
**weaver**.

## License & contributing

Planned license: **MIT** — the simplest, most widely adopted permissive license. It maximizes
adoption and keeps things easy, and it does **not** foreclose a future business: an open-core
model works fine with an MIT core (keep any future hosted server proprietary). Before first
release, the repo will include `LICENSE` and `CONTRIBUTING.md` with setup, the Node + Bun test
matrix, and the bar for changes.
