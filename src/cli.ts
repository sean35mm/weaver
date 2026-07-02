#!/usr/bin/env node
/** Weaver CLI entry: parse → bootstrap (repo + store + identity) → dispatch → exit. */

import fs from "node:fs";
import { type ParsedArgs, parseArgs } from "./args.ts";
import * as activity from "./commands/activity.ts";
import * as audit from "./commands/audit.ts";
import * as check from "./commands/check.ts";
import * as claim from "./commands/claim.ts";
import * as config from "./commands/config.ts";
import * as dashboard from "./commands/dashboard.ts";
import * as deinit from "./commands/deinit.ts";
import * as doctor from "./commands/doctor.ts";
import * as done from "./commands/done.ts";
import * as forget from "./commands/forget.ts";
import * as hook from "./commands/hook.ts";
import * as init from "./commands/init.ts";
import * as log from "./commands/log.ts";
import * as note from "./commands/note.ts";
import * as preflight from "./commands/preflight.ts";
import * as status from "./commands/status.ts";
import * as task from "./commands/task.ts";
import * as toggle from "./commands/toggle.ts";
import * as uninstall from "./commands/uninstall.ts";
import * as upgrade from "./commands/upgrade.ts";
import { loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { resolveIdentity } from "./identity/session.ts";
import { resolveRepoId } from "./repo/identity.ts";
import { EmptyStore } from "./store/empty.ts";
import { ensureWeaverDir, storePathForRepo } from "./store/location.ts";
import { openStore } from "./store/open.ts";
import { DEFAULT_COMMAND_EVENT_MAX_AGE_DAYS, DEFAULT_COMMAND_EVENT_MAX_EVENTS } from "./store/reap.ts";
import { SCHEMA_VERSION } from "./store/schema.ts";
import { CliError } from "./validate.ts";
import { VERSION } from "./version.ts";

const BOOLEAN_FLAGS = new Set([
  "pin",
  "json",
  "full",
  "version",
  "help",
  "v",
  "purge",
  "exclusive",
  "no-open",
  "check",
  "yes",
  "keep-data",
  "project",
  "global",
  "color",
  "no-color",
  "no-touch",
  "staged",
  "upstream",
  "hooks",
  "no-hooks",
  "all",
  "undo",
]);
// Mutating writes that are paused when the project is disabled (done/lifecycle still work).
const WRITE_GATED = new Set(["task", "claim", "release", "note", "forget", "log"]);
const COMMAND_USAGE = new Set(["status", "notes", "activity", "audit", "check", "preflight", "doctor"]);

interface Handler {
  run: (ctx: Ctx) => number | Promise<number>;
  /** Agent/mutating commands require identity and register presence; observers don't. */
  agent: boolean;
  /** `read` never creates a store, `touch` writes only when one exists (read-only fallback if unwritable), `create` creates/migrates. */
  store: StoreMode | ((args: ParsedArgs) => StoreMode);
  /** Skip ladder resolution (incl. the `ps` TTY walk) — for hot paths that derive identity themselves. */
  skipIdentity?: boolean;
}

type StoreMode = "read" | "touch" | "create";

function isMissingSchemaError(e: unknown): boolean {
  return /no such table:/i.test((e as Error)?.message ?? "");
}

const REGISTRY: Record<string, Handler> = {
  task: { run: task.run, agent: true, store: "create" },
  claim: { run: claim.runClaim, agent: true, store: "create" },
  release: { run: claim.runRelease, agent: true, store: "create" },
  note: { run: note.runNote, agent: true, store: "create" },
  forget: { run: forget.run, agent: true, store: "create" },
  log: { run: log.run, agent: true, store: "create" },
  done: { run: done.run, agent: true, store: "create" },
  status: { run: status.run, agent: false, store: "touch" },
  notes: { run: note.runNotes, agent: false, store: "touch" },
  activity: { run: activity.run, agent: false, store: "touch" },
  audit: { run: audit.run, agent: false, store: "touch" },
  check: { run: check.run, agent: false, store: "touch" },
  preflight: { run: preflight.run, agent: false, store: "touch" },
  doctor: { run: doctor.run, agent: false, store: "touch" },
  // Viewers intentionally `create`: they poll the store file, so it must exist even before
  // the first agent writes.
  dashboard: { run: dashboard.runDashboard, agent: false, store: "create" },
  view: { run: dashboard.runDashboard, agent: false, store: "create" },
  ui: { run: dashboard.runDashboard, agent: false, store: "create" },
  watch: { run: dashboard.runWatch, agent: false, store: "create" },
  init: { run: init.run, agent: false, store: "create" },
  enable: { run: toggle.runEnable, agent: false, store: "create" },
  disable: { run: toggle.runDisable, agent: false, store: "create" },
  deinit: { run: deinit.run, agent: false, store: "touch" },
  config: { run: config.run, agent: false, store: "create" },
  upgrade: { run: upgrade.run, agent: false, store: "read" },
  uninstall: { run: uninstall.run, agent: false, store: "read" },
  // Claude Code hook endpoint — fires on every edit, so it derives identity from the hook
  // payload itself and never creates a store in repos that haven't opted in.
  hook: { run: hook.run, agent: false, store: "touch", skipIdentity: true },
};

async function openStoreForMode(repoId: string, mode: StoreMode): Promise<Ctx["store"]> {
  const dbPath = storePathForRepo(repoId);
  if (mode === "read" || mode === "touch") {
    if (!fs.existsSync(dbPath)) return new EmptyStore();
    if (mode === "touch") {
      try {
        return await openStore(dbPath);
      } catch {
        // Unwritable store (permissions, read-only filesystem): fall through to the read
        // path so observer commands keep working; usage metrics degrade on their own.
      }
    }
    let opened = await openStore(dbPath, { readOnly: true, migrate: false });
    try {
      // An older store must be migrated even for readers (queries reference new columns):
      // do a one-time writable open to migrate, then reopen read-only.
      if (Number(opened.getMeta("schema_version") ?? "0") < SCHEMA_VERSION) {
        opened.close();
        (await openStore(dbPath)).close();
        opened = await openStore(dbPath, { readOnly: true, migrate: false });
      }
    } catch (e) {
      opened.close();
      if (isMissingSchemaError(e)) return new EmptyStore();
      throw e;
    }
    return opened;
  }
  ensureWeaverDir();
  return openStore(dbPath);
}

function recordCommandUsage(ctx: Ctx, command: string): void {
  try {
    ctx.store.transaction(() => {
      ctx.store.addCommandEvent({
        ts: ctx.now,
        command,
        sessionId: ctx.identity?.key ?? null,
        harness: ctx.identity?.label ?? null,
        idSource: ctx.identity?.source ?? null,
      });
      ctx.store.pruneCommandEvents({
        maxEvents: DEFAULT_COMMAND_EVENT_MAX_EVENTS,
        maxAgeDays: DEFAULT_COMMAND_EVENT_MAX_AGE_DAYS,
        now: ctx.now,
      });
    });
  } catch {
    // Usage metrics are best-effort and must never break observer commands or missing-store reads.
  }
}

function printHelp(write: (s: string) => void): void {
  write(`weaver ${VERSION} — shared context for coding agents\n\n`);
  write("commands:\n");
  write("  status [--json] [--full]                 who's active, claims, activity, notes\n");
  write("  task <intent…>                           announce what you're working on\n");
  write("  claim <glob> [--reason …] [--ttl 30m]    stake out an area (exit 1 = recorded, but conflicts exist)\n");
  write("  release <glob>                           free an area\n");
  write(
    "  check <path> [--no-touch]                is anyone else here? (exit 1 on conflict; --no-touch skips heartbeat refresh)\n",
  );
  write("  preflight [paths…|--staged|--upstream|--base REF]  bounded commit/push/PR risk check\n");
  write("  note <text…> [--pin] [--path …] [--tag …] [--update <id>]  record a durable learning\n");
  write(
    "  notes [query…] [--full] [--all] [--path PATH] [--tag TAG] [--json]  list/search notes (--all includes retired/superseded)\n",
  );
  write("  forget <id> <why…>                       retire a wrong/obsolete note (--undo <id> restores)\n");
  write("  log <kind> <path> <summary…>             record an activity event\n");
  write("  activity [query…] [--kind K] [--path P] [--since 2h] [--full]  recent activity feed (searchable)\n");
  write("  audit [--json]                           summarize retained usage, setup, and improvements\n");
  write("  done                                     end this session, release its claims\n");
  write("  doctor                                   diagnostics (identity, repo, store)\n");
  write("  dashboard [--port N] [--no-open]         live web view (Ctrl-C to stop)\n");
  write("  watch                                    live terminal view (Ctrl-C to stop)\n");
  write("\n");
  write(
    "  init [--project|--global] [--hooks|--no-hooks]  install agent instructions (this repo, or global = every repo)\n",
  );
  write("  hook <pre-edit|post-edit>                Claude Code hook endpoint (payload JSON on stdin)\n");
  write("  disable / enable                         pause / resume agent writes for this repo\n");
  write("  deinit [--project|--global] [--purge]    remove instructions (and optionally the store)\n");
  write("  config [<key> [<seconds>]]               view/set tunables (TTLs)\n");
  write("  upgrade [--check]                        update the installed binary to the latest release\n");
  write("  uninstall [--yes] [--keep-data]          remove the binary and ~/.weaver\n");
  write("\n");
  write("global flags: --color[=always|auto|never], --no-color\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const out = (s: string): void => void process.stdout.write(s);
  const err = (s: string): void => void process.stderr.write(s);
  let store: Ctx["store"] | null = null;

  const first = argv[0];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    printHelp(out);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    out(`${VERSION}\n`);
    return 0;
  }

  const handler = REGISTRY[first];
  if (!handler) {
    err(`unknown command: ${first}\n\n`);
    printHelp(err);
    return 1;
  }

  try {
    const args = parseArgs(argv, BOOLEAN_FLAGS);
    const repo = resolveRepoId();
    const mode = typeof handler.store === "function" ? handler.store(args) : handler.store;
    store = await openStoreForMode(repo.repoId, mode);
    const identity = handler.skipIdentity ? null : resolveIdentity();
    const now = Date.now();
    const ctx: Ctx = {
      store,
      identity,
      repo,
      config: loadConfig(store),
      cwd: process.cwd(),
      now,
      env: process.env as Record<string, string | undefined>,
      args,
      out,
      err,
    };

    const enabled = (store.getMeta("enabled") ?? "1") !== "0";
    if (!enabled && WRITE_GATED.has(first)) {
      err("weaver: disabled for this project (`weaver enable` to resume)\n");
      return 0;
    }
    if (handler.agent) {
      if (!identity) {
        err("weaver: couldn't resolve a session identity for this command.\n");
        err("  set WEAVER_SESSION=<stable-id>, or run inside a supported agent harness.\n");
        return 1;
      }
      store.upsertSession(
        { id: identity.key, harness: identity.label, idSource: identity.source, pid: process.pid, cwd: process.cwd() },
        now,
      );
    } else if (enabled && COMMAND_USAGE.has(first)) {
      recordCommandUsage(ctx, first);
    }
    return await handler.run(ctx);
  } catch (e) {
    if (e instanceof CliError) {
      err(`weaver: ${e.message}\n`);
      return e.code;
    }
    err(`weaver: unexpected error: ${(e as Error)?.message ?? e}\n`);
    return 1;
  } finally {
    try {
      store?.close();
    } catch {
      /* may already be closed by `deinit --purge` */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`weaver: unexpected error: ${e?.message ?? e}\n`);
    process.exit(1);
  });
