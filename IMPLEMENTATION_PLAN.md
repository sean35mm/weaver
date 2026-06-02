# Weaver — v1 Implementation Plan

**Goal:** Ship a CLI-first, serverless tool that gives multiple coding agents working in
the same repo shared situational awareness — presence, claims, notes, activity — via fast
local bash commands, with a real-time visualization.

**Architecture:** A single TypeScript CLI (`weaver`) over a local SQLite store (WAL),
keyed by repo identity, with all persistence behind a thin `Store` interface and all
identity behind a single `resolveIdentity()` seam. No daemon, no MCP. Liveness via lazy
TTL reaping at read time. Runtime-agnostic (Node and Bun).

**Tech stack:** TypeScript · Node ≥22.5 / Bun (runtime-agnostic) · SQLite via built-in
bindings (`node:sqlite` / `bun:sqlite`, **no native dependency**) · `picomatch` for glob
matching · a minimal CLI arg parser · a tiny HTTP + SSE server and a single static page for
the dashboard. (`better-sqlite3` is a documented future fallback if older-Node support is
requested; not bundled in v1.)

> **Process note:** Per project convention this plan favors pragmatic, well-scoped tasks
> over rigid test-first micro-steps. Tests are specified where they carry real risk
> (storage, glob/conflict logic, identity resolution, TTL reaping) and are lighter for
> plumbing and presentation. **Phase 0 is a hard decision gate** — do not build on the
> identity model until the spike validates it.

---

## Current state (post-launch)

The v1 CLI, local SQLite store, lifecycle commands, dashboard/watch, installer, release
plumbing, and Node/Bun test matrix are shipped. The checklist below has been reconciled to
reflect shipped work; the remaining roadmap starts at the optional v1.1 hook workstream and
post-v1 per-harness packaging.

---

## Guiding constraints (do not violate)

1. **CLI-first.** The CLI must be fully useful with zero hooks. Hooks are future/opt-in.
2. **Serverless.** No long-running process is part of coordination. Each command is a
   short-lived process over a local file. (The dashboard server is a *read-only human
   viewer*, not part of coordination.)
3. **Never block.** Claims are advisory; Weaver surfaces conflicts, agents decide.
4. **Runtime-agnostic.** Works under Node and Bun; pick the SQLite binding at runtime.
5. **Fast & quiet.** Tiny local store operations and terse output; `status`/`check` are
   silent when there's nothing relevant, to keep agent token cost near zero. Do not promise
   single-digit-ms total CLI runtime because Node/Bun startup is outside the store's control.
6. **Clean seams.** Persistence behind `Store`; identity behind `resolveIdentity()`.

---

## Repository / file structure

```
weaver/
├── package.json                # name "@narulabs/weaver", bin: { weaver: dist/cli.js }
├── tsconfig.json
├── README.md                   # (already written)
├── IMPLEMENTATION_PLAN.md      # (this file)
├── LICENSE                     # MIT (Project Foundations)
├── CONTRIBUTING.md             # setup, Node+Bun test matrix, contribution bar
├── CHANGELOG.md                # Keep-a-Changelog; maintained by release-please
├── .github/workflows/          # ci.yml (typecheck + Node/Bun tests) + release-please.yml
├── src/
│   ├── cli.ts                  # entrypoint: arg parsing → dispatch to commands
│   ├── args.ts                 # tiny hand-rolled arg parser (zero-dep, fast startup)
│   ├── validate.ts             # CLI-boundary validation (lenient+warn): parseTtl, normalizeKind, clamp, requireArg
│   ├── config.ts               # load TTL/recent-activity config from weaver_meta
│   ├── context.ts              # command context type
│   ├── env.ts                  # standalone-binary detection
│   ├── glob.ts                 # path-vs-glob + glob-overlap heuristics (picomatch)
│   ├── conflict.ts             # 3-tier conflict detection over the store
│   ├── render.ts               # terse human output + --json shapes
│   ├── version.ts              # package.json version source of truth
│   ├── version.generated.ts    # generated standalone-binary fallback version
│   ├── commands/               # one file per verb; each exports run(ctx, args)
│   │   ├── init.ts
│   │   ├── status.ts
│   │   ├── task.ts
│   │   ├── claim.ts            # claim + release
│   │   ├── check.ts
│   │   ├── note.ts             # note + notes
│   │   ├── log.ts
│   │   ├── activity.ts
│   │   ├── done.ts
│   │   ├── toggle.ts           # disable + enable
│   │   ├── deinit.ts
│   │   ├── dashboard.ts        # dashboard + watch
│   │   └── doctor.ts           # print resolved identity, repo-id, store path, runtime/binding
│   ├── store/
│   │   ├── store.ts            # `Store` interface (the seam)
│   │   ├── sqlite.ts           # SQLite implementation of Store
│   │   ├── db.ts               # runtime-aware openDb() binding adapter
│   │   ├── schema.ts           # DDL + migrations + schema_version
│   │   └── reap.ts             # lazy staleness/TTL computation at read time
│   ├── identity/
│   │   └── session.ts          # resolveIdentity() + harness detection
│   ├── repo/
│   │   ├── identity.ts         # resolveRepoId(): git remote → root commit → cwd hash
│   │   └── paths.ts            # normalize command targets to repo-root-relative POSIX paths/globs
│   ├── instructions/
│   │   └── block.ts            # the fenced CLAUDE.md/AGENTS.md block + inject/remove
│   └── dashboard/
│       ├── server.ts           # tiny HTTP + SSE server over the Store (read-only)
│       └── page.ts             # inlined single-page live view
├── scripts/
│   ├── demo.ts                 # spawn N simulated agents → store (test fixture + launch GIF)
│   └── write-version.ts        # stamp version.generated.ts from package.json
└── test/
    ├── store.test.ts
    ├── glob.test.ts
    ├── conflict.test.ts
    ├── identity.test.ts
    ├── reap.test.ts
    └── integration/multi-session.test.ts
```

---

## Project foundations (before any feature code)

Wire up licensing, versioning, and release plumbing at repo creation so every commit is
released cleanly from day one.

- [x] **License.** Add an `MIT` `LICENSE` file (copyright Sean / Weaver contributors).
- [x] **Versioning = SemVer**, starting at **`0.1.0`**. Treat `0.x` as pre-stable (minor
      bumps may break); cut `1.0.0` when the CLI surface is stable.
- [x] **Conventional Commits.** Adopt `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` /
      `test:` (already a project convention). This drives automated changelog + version bumps.
- [x] **Automated releases via `release-please`.** A GitHub Action reads conventional commits
      and opens a "Release vX.Y.Z" PR with the version bump + `CHANGELOG.md` entry; merging it
      creates the annotated `vX.Y.Z` tag and triggers npm publish. PR-based = you review every
      release (preferred over auto-publish-on-merge).
- [x] **`CHANGELOG.md`** in Keep-a-Changelog format, maintained by `release-please`.
- [x] **CI** (`.github/workflows/ci.yml`): typecheck + test on every PR, under **both
      Node and Bun**. Branching stays simple: `main` is always releasable; work on branches → PRs.
- [x] **npm publish config.** `package.json` `"version": "0.1.0"`, `"publishConfig": {
      "access": "public" }` (scoped packages default to private otherwise). Publishing waits on
      the npm account (Open Decision #1) but the workflow can be staged.

## Phase 0 — Session-identity spike (DE-RISK FIRST) 🔬 — **decision gate**

**Why:** Everything depends on reliably answering "which session am I?" from a short-lived
`weaver` invocation. If TTY-based identity is unreliable in real harnesses, we must learn
it *before* building the data model on it.

**Deliverable:** A throwaway script (not shipped) that prints the derived session key and
its source.

**Resolution ladder (validated/updated by the spike — explicit → harness session → TTY → none):**
- **Spike finding (Claude Code tool call, via cmux):** the immediate process has NO controlling
  tty (`ps -o tty=` → `??`, all stdio piped), but `CLAUDE_CODE_SESSION_ID` is in env and the
  tty is recoverable by walking ancestry to the `claude` process (`ttys007`). This reordered
  the ladder — harness env id is the *primary* signal, not TTY.
- **1. Explicit** — `--session` / `WEAVER_SESSION`. Key `explicit:<id>@<host>`.
- **2. Harness session id** — first present of a per-harness env var. **Confirmed registry:**
  `CLAUDE_CODE_SESSION_ID`, `OPENCODE_RUN_ID`, `CODEX_THREAD_ID` (Pi exposes none → falls to
  tty/explicit). Key `harness:<label>:<id>@<host>`. Most reliable for tool calls; unique per
  session. **Required for Codex**, whose seatbelt sandbox hides tty + ancestry entirely.
- **3. Controlling TTY (self → nearest ancestor)** — `ps -o tty= -p <pid>` walking the parent
  chain to the first real tty (not `stdout.isTTY`). Key `tty:<device>@<host>`.
- **4. None** — no anonymous key; observer reads + `check` still work; mutating commands fail
  with a `WEAVER_SESSION` hint.
- Harness label from the matched session env var, else `$CLAUDECODE`/etc.; default `unknown`.

**Spike results (all four harnesses driven headlessly via `opencode run` / `codex exec` /
`pi --print`, 2026-05-29):**
- [x] **Claude Code** → `CLAUDE_CODE_SESSION_ID` (UUID); tty via ancestry. ✓
- [x] **OpenCode** → `OPENCODE_RUN_ID` (UUID); tty via ancestry. ✓
- [x] **Codex** → `CODEX_THREAD_ID` (UUID). **Seatbelt sandbox** (`CODEX_SANDBOX=seatbelt`):
      NO tty, NO ancestry (single isolated proc) → the env id is the ONLY signal. ✓
- [x] **Pi** → **no session env var** (only `PI_CODING_AGENT=true`); not sandboxed → resolves
      via tty/ancestry or explicit `--session`. ✓
- All harness ids are per-session UUIDs → two sessions of the same harness ⇒ distinct keys (the
      core requirement) holds by construction.
- ⚠️ *Caveat:* these runs were driven *nested* from Claude Code, so each child inherited
      `CLAUDE_CODE_*` env (the spike's RESOLVED KEY was therefore polluted toward claude-code).
      We extracted each harness's OWN var from the env dump. A clean confirmation — launch each
      harness independently from a fresh terminal, run two same-harness sessions — is a
      nice-to-have, not blocking; the env-var evidence is conclusive for 3/4.

**Decision gate: ✅ PASSED.** Registry confirmed (`CLAUDE_CODE_SESSION_ID` / `OPENCODE_RUN_ID` /
`CODEX_THREAD_ID`; Pi → tty/explicit). Proceed to Phase 1. Any future harness with neither an
env id nor a recoverable tty uses explicit `WEAVER_SESSION`, documented in its instruction block.

---

## Phase 1 — Scaffold + storage core

**Outcome:** A runnable, runtime-agnostic skeleton that can open the repo's store and run
migrations.

- [x] **Scaffold the package.** `package.json` (`@narulabs/weaver`, `bin.weaver →
      dist/cli.js`, alphabetized deps), `tsconfig.json`, build script that targets both
      Node and Bun. Add `picomatch` and a minimal arg parser. SQLite uses the built-in
      `node:sqlite` (Node ≥22.5) / `bun:sqlite` — **no native dependency**. Package ships as
      scoped `@narulabs/weaver`.
- [x] **`repo/identity.ts` — `resolveRepoId()`.** First find the repo root with
      `git rev-parse --show-toplevel` (so it works from any subdir). Then try
      `git remote get-url origin` and **normalize it** (strip protocol, normalize `git@host:`
      ssh vs `https://` forms, drop trailing `.git`/`/`) so the same repo always hashes the
      same; on failure use the root-commit hash (`git rev-list --max-parents=0 HEAD`); on
      failure hash the absolute toplevel path. Return a stable short id. *Test:* deterministic
      id for a fixture repo; same id from a subdir; same id for ssh vs https remote forms;
      stable across two worktrees of the same remote.
- [x] **`repo/paths.ts` — target normalization.** Normalize all user-supplied paths/globs to
      repo-root-relative POSIX form before storage or matching. Handle commands run from
      subdirs, absolute paths inside the repo, `./`, `..`, Windows separators, and glob
      metacharacters without accidentally resolving glob patterns as literal files. *Test:*
      equivalent target spellings normalize to the same stored path/glob.
- [x] **`store/db.ts` — runtime-aware binding adapter.** Detect Bun → `bun:sqlite`; else
      `node:sqlite` (Node ≥22.5). (`better-sqlite3` is a future fallback for older Node, not in
      v1.) Expose a uniform `openDb(path)`
      returning `{ exec, prepare, transaction, close }`. Enable `PRAGMA journal_mode=WAL`,
      `PRAGMA foreign_keys=ON`, and a small `busy_timeout` for concurrent agent writes.
- [x] **`store/schema.ts` — DDL + migrations.** Create the five tables from the README;
      record `schema_version` in `weaver_meta`. Add indexes for common reads:
      `sessions(last_seen, ended_at)`, `claims(session_id, released_at, expires_at)`,
      `claims(pattern)`, `activity(ts, target)`, and `notes(pinned, path, created_at)`.
      Sessions are small identity records and are not deleted in v1 while referenced by
      claims, notes, or activity. Idempotent `migrate(db)`.
- [x] **`store/store.ts` — the `Store` interface.** Methods the verbs need, e.g.
      `upsertSession`, `touchSession`, `endSession`, `listActiveSessions`, `addClaim`,
      `releaseClaim`, `listActiveClaims`, `addNote`, `listNotes`, `addActivity`,
      `listRecentActivity`, `getMeta`/`setMeta`. Include either a generic `transaction()`
      seam or higher-level atomic methods for multi-row verbs (`task + activity`,
      `claim + activity`, `done + release claims + activity`). Keep it persistence-agnostic.
- [x] **`store/sqlite.ts` — implement `Store` over `openDb`.** Prepared statements; epoch-ms
      timestamps passed in (never `Date.now()` inside pure logic — inject a clock for
      testability).
- [x] **`store/reap.ts` — lazy staleness + retention.** `isStale(session, now, ttl)` and
      helpers so reads exclude stale sessions and treat expired claims as free. Also
      `pruneActivity(db, now, {maxEvents, maxAgeDays})` called on activity writes to drop the
      oldest events beyond the cap, and prune released/expired claims after their usefulness
      window. Do **not** delete session rows in v1 while they may be referenced. *Test:* a
      session past TTL is excluded; a claim past `expires_at` reads as free; activity beyond
      `maxEvents`/`maxAgeDays` is pruned; retained activity still has a valid session ref.

*Phase acceptance:* `openStore(repoId)` creates/migrates the DB and round-trips a session
insert + read under both Node and Bun.

---

## Phase 2 — Core verbs

**Outcome:** The full agent-facing protocol works end to end from the shell.

**Validation philosophy:** No schema library in v1 — parameterized SQL prevents injection and
the SQLite schema (`NOT NULL`, `FOREIGN KEY`, `PK`) enforces structural integrity for free.
Validation is lightweight and lives only at the CLI boundary, **lenient + warn**: friendly
message + clean exit on broken input, **never a stack trace**; observers and `check` never
crash a tool call. A schema lib (Zod/valibot) is deferred to the cross-machine sync API, where
untrusted payloads actually arrive.

- [x] **`args.ts` + `validate.ts` — CLI boundary.** Hand-rolled zero-dep arg parser plus
      lenient validators: `requireArg` (missing required arg / empty pattern → friendly hint +
      non-zero exit), `normalizeKind` (unknown activity kind → `run` with a stderr note),
      `parseTtl` (`"30m"` → ms, bounded), `clamp` (cap reason/note/summary/intent length), and
      a broad-glob flag (`**` / `/` allowed but warned). *Test:* ttl parse + bounds, kind
      coercion, length clamp, missing-arg → non-zero exit, observer never throws.

- [x] **`identity/session.ts` — `resolveIdentity()`** implements the validated ladder:
      explicit (`--session`/`WEAVER_SESSION`) → harness-native session id (registry confirmed in
      Phase 0: `CLAUDE_CODE_SESSION_ID`, `OPENCODE_RUN_ID`, `CODEX_THREAD_ID`) → controlling
      tty (self → nearest ancestor via `ps`) → structured "unavailable". Returns
      `{ key, source, label }`; the key is namespaced by source/harness to avoid cross-harness
      collision. Harness detection here.
- [x] **Presence registration matrix.** Do not let human observer commands create fake live
      sessions. Agent/session commands (`task`, `claim`, `release`, `note`, `log`, `done`)
      require stable identity, upsert the session, and bump `last_seen`. `check` resolves
      identity for self-exclusion, but does not create a new session; if the stable identity
      already has an active row, it may touch that row, otherwise it runs as an observer and
      never crashes. Observer/lifecycle commands
      (`status`, `notes`, `activity`, `dashboard`, `watch`, `doctor`, `init`, `enable`,
      `disable`, `deinit`) do not upsert/touch by default. *Test:* observer commands do not
      create sessions; agent commands do; headless mutating commands fail with the explicit
      session hint.
- [x] **`task`.** `weaver task "<intent>"` → set `sessions.intent`. Add a `task` activity row.
- [x] **`claim` / `release`.** Normalize the target glob, then
      `weaver claim '<glob>' --reason "<why>" [--ttl 30m]` inserts or refreshes the caller's
      claim in a transaction and adds a `claim` activity row. Co-claims are allowed, but
      `claim` must run conflict detection against other live claims/recent activity, print
      the same context as `check`, and exit `1` when overlap is present (`0` when clear).
      `release '<glob>'` normalizes the glob, sets `released_at`, and logs `release`.
- [x] **`glob.ts`.** `matchesPath(glob, path)` via picomatch (precise over normalized
      repo-relative POSIX paths); `globsOverlap(a, b)` heuristic for claim-vs-claim overlap
      warnings (segment/prefix containment + bidirectional sample matching). Bias toward
      false positives: if overlap is uncertain, return "possible overlap" because claims are
      advisory and missing a real overlap is worse. *Test:* `src/auth/**` matches
      `src/auth/login.ts`; non-overlap, overlap, and uncertain cases for `globsOverlap`.
- [x] **`conflict.ts`.** Given a path/glob + the live store, return the highest tier
      (Hard/Soft/Stale/Clear) plus the offending session(s) and their context. Soft conflict
      uses configurable `recent_activity_seconds` (default proposed: 15–30 min). *Test:*
      each tier with crafted store states, excluding self and stale holders.
- [x] **`check`.** Normalize the path/glob, run detection, print the descriptive payload;
      exit `0` clear / `1` conflict. If identity is unavailable, run as an observer rather
      than crashing. *Test:* exit codes per tier; headless observer behavior.
- [x] **`note` / `notes`.** Write a note (optional normalized `--path`, `--tag`, `--pin`);
      list notes (pinned first, newest first). Support `supersedes` when `--update <id>`.
- [x] **`log`.** `weaver log <kind> <path> "<summary>"` → activity row with normalized target
      (kind validated).
- [x] **`activity`.** Print recent activity (default last N), `--json` supported.
- [x] **`status`.** Compose active sessions + active claims + recent activity + top/pinned
      notes into a terse human view. It is silent/one-line only when there are no other live
      sessions, no active claims, no pinned notes, and no recent relevant activity. `--json`
      shape via `render.ts`. **Cap output by default** (top-N recent activity, truncated
      summaries) to stay token-cheap, with `--full` to emit everything. *Test:* JSON shape;
      emptiness behavior including pinned notes; cap applied without `--full`.
- [x] **`done`.** End the caller's session (`ended_at`) and release its active claims.
- [x] **`doctor`.** Print the resolved `{ key, source, label }`, repo-id + store path,
      detected runtime + SQLite binding, and enabled state. This is the primary tool for
      debugging identity in the wild (the riskiest part of the design). *Test:* outputs a
      well-formed report against a fixture store.

*Phase acceptance:* an integration test simulates 3 sessions (distinct injected keys) doing
task/claim/check/log/note/done and asserts each sees the others correctly, including a
surfaced conflict.

---

## Phase 3 — `init`, instruction injection, lifecycle

**Outcome:** One-command enablement and clean teardown.

- [x] **`instructions/block.ts`.** Export the exact fenced block (from the README — the
      right-sized version that leads with high-ROI behaviors `status`/`task`/`claim`/`note`
      and demotes per-file `check`/`log` to "optional, when useful"), plus
      `injectBlock(fileContents)` (idempotent: replace between `weaver:start`/`weaver:end`
      markers, else append) and `removeBlock(fileContents)`. Treat the wording as a tuning
      target, not final.
- [x] **`init`.** Resolve repo id, create/migrate the store, set `weaver_meta.enabled=1`,
      inject the block into `CLAUDE.md` and `AGENTS.md` (create if absent), print a summary.
      Idempotent on re-run. *Test:* re-running `init` doesn't duplicate the block.
- [x] **`disable` / `enable`.** Toggle `weaver_meta.enabled`. When disabled,
      agent-start/update commands (`task`, `claim`, `release`, `note`, `log`) no-op quickly
      and silently enough for agents; `check` may still read as an observer; read commands
      work for inspection and show disabled state to humans; lifecycle cleanup commands
      (`done`, `enable`, `deinit`) still work. *Test:* claim while disabled records nothing;
      `done` can still release the caller's active claims; read commands do not create
      sessions.
- [x] **`deinit`.** Remove the block from `CLAUDE.md`/`AGENTS.md`; with `--purge`, delete the
      repo's DB file. *Test:* block removed cleanly, surrounding content preserved.

*Phase acceptance:* `init` → agents-can-coordinate → `disable` → `enable` → `deinit` cycle
works on a fixture repo without leaving stray content.

---

## Phase 4 — Visualization (`dashboard` + `watch`)

**Outcome:** A human can watch the commons live. **Self-contained and read-only**, so it
cannot destabilize the core.

- [x] **`dashboard/server.ts`.** Start a tiny HTTP server on `127.0.0.1` (configurable port,
      default 7777; auto-pick if taken). Routes: `GET /` (serve `index.html`), `GET /events`
      (SSE) that polls the `Store` ~1s and emits the same JSON shape `status --json`
      produces. Read-only. Open the browser (best-effort: `open` on macOS, `xdg-open` on
      Linux, `cmd /c start` on Windows).
- [x] **`dashboard/page.ts`.** Single page, vanilla JS, `EventSource('/events')`.
      Render: a card/lane per active session (harness, intent, tty, heartbeat age), the
      claim map (glob → holder + reason), a streaming activity timeline, and the notes
      panel. Minimal, clean styling; no build step.
- [x] **`dashboard` command.** Wire `weaver dashboard` (aliases `view`/`ui`) to launch the
      server in the foreground until `Ctrl-C`.
- [x] **`watch` command.** Terminal TUI: clear+redraw the `status` view on a ~1s interval
      until `Ctrl-C`. (ANSI redraw; no heavy TUI dep.)

*Phase acceptance:* with simulated sessions writing to the store, the dashboard reflects
new claims/activity within ~1–2s, and `watch` refreshes in the terminal.

---

## Phase 5 — Polish, docs, release

- [x] **Output polish.** Consistent terse formatting; friendly, descriptive conflict
      messages; `--help` for the binary and each verb; sensible exit codes.
- [x] **Config & TTLs.** `weaver_meta.session_ttl_seconds` (session staleness),
      `claim_ttl_seconds`, and `recent_activity_seconds`; allow `--ttl` overrides; document
      defaults (session ~15m, claim ~30m).
- [x] **Errors & safety.** Support non-git directories via the cwd-hash repo-id fallback;
      emit clear errors only for real failures (unwritable store path, invalid args, missing
      stable identity for session-mutating commands). Never throw raw stack traces at agents;
      `check` must never crash a tool call.
- [x] **README finalization.** Ensure README matches shipped behavior; lead with the
      *con-texere* origin story.
- [x] **Contributing.** Add `CONTRIBUTING.md` (setup, the Node+Bun test matrix, the PR bar).
      (`LICENSE`, versioning, and release plumbing were established in *Project foundations*.)
- [x] **Demo / launch asset.** `scripts/demo.ts` spawns N simulated agents writing realistic
      task/claim/activity/note rows to a throwaway store so `weaver dashboard`/`watch` show
      live coordination. Doubles as a manual smoke test and the launch GIF. (Shares the
      simulated-session harness used by the Phase-2 integration test.)
- [x] **Distribution.** Publish `@narulabs/weaver` to npm with a `bin`. Add a
      `bun build --compile` (and Node SEA, optional) path to produce prebuilt single
      binaries + a GitHub-Pages-hosted `curl | sh` install script. Document the supported
      runtime matrix.
- [x] **CI/release green.** Confirm the `ci.yml` (from foundations) passes on Node & Bun, and
      that `release-please` cuts a clean `0.1.0` release PR + npm publish once the account exists.

*Phase acceptance:* a fresh machine can `npm i -g @narulabs/weaver`, `weaver init` a repo,
and the documented new-user flow works.

---

## Testing strategy

- **Unit (highest value):** `store` round-trips; `repo/paths` normalization;
  `glob.ts` (path-vs-glob + overlap); `conflict.ts` (all four tiers, self/stale
  exclusion); `identity/session` (explicit override, TTY key shape, unavailable identity,
  harness label) with mocked tty/env; `reap` (TTL boundaries). Inject a clock — no
  `Date.now()` inside pure logic.
- **Integration:** `test/integration/multi-session.test.ts` — open one store, drive N
  sessions via *injected* session keys (so we don't need real terminals), and assert
  cross-visibility, observer commands not creating sessions, claim conflict surfacing + exit
  code, co-claims, TTL reaping, disabled-mode behavior, and `done` cleanup.
- **Cross-runtime:** run unit + integration under both Node and Bun in CI.
- **Manual smoke:** the Phase-0 spike matrix re-run on the real binary, plus a scripted
  "spawn 3 fake agents" demo for the README/launch.

---

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **Identity on the tool-call path** — spike showed the immediate process often has no controlling tty | Resolve via harness-native session-id env var first (e.g. `CLAUDE_CODE_SESSION_ID`), then ancestry tty, then explicit `WEAVER_SESSION`; never a shared anonymous key (mutating cmds fail with a hint). Per-harness env-var registry confirmed in Phase 0. |
| **Agents don't follow the instruction block** (CLI-first reliability) | Treat the block as a living, tuned artifact; keep it tight; hooks as the opt-in reliability upgrade (roadmap). |
| **Point-in-time awareness** — without hooks an agent only sees the picture at task start; mid-task changes by others go unnoticed | Document the limitation honestly; the v1.1 `SessionStart` hook improves startup awareness only; instruction block nudges re-checking before risky edits; later `PreToolUse` hooks address mid-task changes. |
| **Runtime SQLite binding differences** (Node vs Bun) | Single `openDb()` adapter; CI runs both; avoid binding-specific SQL. Node uses built-in `node:sqlite` (≥22.5); `better-sqlite3` is a future fallback for older Node, not bundled in v1. |
| **Path/glob mismatches from subdirs or OS separators** | Normalize every stored/matched target to repo-root-relative POSIX form in one `repo/paths.ts` seam before conflict detection. |
| **Pure-WASM SQLite weak at multi-process WAL** | Require a real on-disk binding per runtime (`bun:sqlite` / `node:sqlite`); do not ship a WASM fallback as the multi-process store. |
| **Precise glob-vs-glob intersection is hard** | `check` uses precise path-vs-glob; claim-vs-claim uses a pragmatic overlap heuristic and, because co-claims are allowed, exactness is non-critical (both are surfaced anyway). |
| **Dashboard server perceived as violating "serverless"** | It's read-only, on-demand, foreground, and never touched by agents; documented explicitly. |

---

## Post-launch hardening — completed 2026-06-02

- [x] **Version correctness.** Source/npm builds read `package.json`; standalone binaries use a
      generated stamped fallback.
- [x] **Installer/upgrade integrity.** Release workflows attach SHA256 checksum files;
      `install.sh` and `weaver upgrade` verify before replacing binaries.
- [x] **Friendly bootstrap errors.** Repo/store/config bootstrap runs inside the same user-facing
      CLI error boundary as command dispatch.
- [x] **Atomic command writes.** Multi-row verbs use the `Store.transaction()` seam.
- [x] **Retention pruning.** Activity pruning runs after all activity writes, and old
      released/expired claims are pruned after a usefulness window.
- [x] **Status polish.** Empty status keeps `weaver: no other active agents` and can show recent
      completed sessions.
- [x] **Privacy-safe JSON.** `status --json` emits short display ids rather than full session keys.
- [x] **Path boundary hardening.** Targets outside the repo are rejected before storage/matching.
- [x] **Nested integration coverage.** The Node test script discovers nested tests, including the
      multi-session integration flow.
- [x] **Windows dashboard open.** Browser launch uses `cmd /c start` on Windows.

---

## v1.1 — fast follow (optional `SessionStart` hook)

The cheapest, highest-ROI reliability upgrade, kept out of core v1 to keep it pure-CLI:

- [ ] **`weaver init --hooks=session`** wires a single Claude Code `SessionStart` hook that
      runs `weaver status` and injects the picture once at session start. No per-edit or
      per-prompt cost; stays silent when nothing relevant exists. Improves startup awareness
      but does not solve mid-task conflicts by itself. Idempotent install/removal alongside
      the instruction block.

## Out of scope for v1 (roadmap)

Full hooks layer (opt-in, cheap, never per-prompt) · cross-machine sync (paid seam) ·
dashboard "pro" (history/audit, org notes, actions) · full identity ladder (process
ancestry) · broader instruction-file targets (`.cursor/rules`, Windsurf) · optional graph
backend behind `Store`.

### Per-harness packaging (post-v1 workstream)

The CLI stays the universal engine (the only substrate every harness can call); packaging is
an optional wrapper layer on top that improves activation reliability and distribution. A
skill/plugin does **not** replace the CLI — it bundles/wraps it. Decided architecture:

- **Claude Code Plugin** — bundles (a) a **Skill** (a discoverable, richer form of the
  instruction block), (b) the **hooks** (SessionStart + PreToolUse — the real reliability
  win), and (c) optionally the **bundled CLI** so there's no separate `npm i -g`. Best-of-all
  Claude Code experience.
- **OpenCode / Pi** — thin TS plugin/extension wrappers over the CLI.
- **Everything else** — CLI + `AGENTS.md` baseline (already the v1 path).

Reliability ranking that drives this: hooks (deterministic) > skill/MCP/instruction-block
(all model-discretion) — and shared-state accuracy is identical regardless of packaging, since
it's the CLI's store logic. MCP was rejected for the same reason a skill-first approach is:
both fragment the cross-harness guarantee that is Weaver's core value.

---

## Decisions confirmed for v1

1. ✅ **npm account/scope** — package ships as `@narulabs/weaver`; release assets are published
   from `sean35mm/weaver`.
2. ✅ **Arg parser** — hand-rolled, zero-dep (decided).
3. ✅ **Default TTLs** — session staleness ~15 min, claim ~30 min; tunable via
   `weaver_meta` (decided).
4. ✅ **Target harnesses for v1** — drives which instruction files `init` writes and which the
   Phase-0 spike covered. `init` writes **CLAUDE.md + AGENTS.md**
   (AGENTS.md is the emerging cross-tool standard, so it covers OpenCode, Codex, Pi, Gemini
   CLI, Amp, Crush, etc. for free); **actively test** OpenCode + Claude Code + Codex + Pi in
   Phase 0 (all terminal-native, AGENTS.md/CLAUDE.md-based); defer IDE-embedded harnesses
   (Cursor IDE, Windsurf, Cline/Roo, Continue, Copilot) that use different rule files and lack
   a clean TTY.
5. ✅ **Phase-0 outcome** — harness env ids are primary for Claude Code, OpenCode, and Codex;
   Pi falls back to TTY/explicit identity.
