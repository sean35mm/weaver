#!/usr/bin/env node
/** Weaver CLI entry: parse → bootstrap (repo + store + identity) → dispatch → exit. */

import fs from "node:fs";
import { type ParsedArgs, parseArgs } from "./args.ts";
import * as activity from "./commands/activity.ts";
import * as audit from "./commands/audit.ts";
import * as check from "./commands/check.ts";
import * as claim from "./commands/claim.ts";
import * as config from "./commands/config.ts";
import * as deinit from "./commands/deinit.ts";
import * as doctor from "./commands/doctor.ts";
import * as done from "./commands/done.ts";
import * as forget from "./commands/forget.ts";
import * as hook from "./commands/hook.ts";
import * as init from "./commands/init.ts";
import * as log from "./commands/log.ts";
import * as note from "./commands/note.ts";
import * as preflight from "./commands/preflight.ts";
import * as scratchpad from "./commands/scratchpad.ts";
import * as status from "./commands/status.ts";
import * as task from "./commands/task.ts";
import * as toggle from "./commands/toggle.ts";
import * as uninstall from "./commands/uninstall.ts";
import * as upgrade from "./commands/upgrade.ts";
import { loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { resolveIdentity } from "./identity/session.ts";
import { resolveRepoId } from "./repo/identity.ts";
import { registerStoreHolder, type StoreHolderHandle } from "./store/coordination.ts";
import { EmptyStore } from "./store/empty.ts";
import { ensureWeaverDir } from "./store/location.ts";
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
  "headings",
]);
// Mutating writes that are paused when the project is disabled (done/lifecycle still work).
const WRITE_GATED = new Set(["task", "claim", "release", "note", "fact", "forget", "log"]);
const COMMAND_USAGE = new Set(["status", "notes", "facts", "activity", "audit", "check", "preflight", "doctor"]);

type PresenceMode = "observer" | "optional" | "required";

interface Handler {
  run: (ctx: Ctx) => number | Promise<number>;
  /** Whether identity/presence is ignored, optional (human-or-agent), or required. */
  presence: PresenceMode | ((args: ParsedArgs) => PresenceMode);
  /** `read` never creates a store, `touch` writes only when one exists (read-only fallback if unwritable), `create` creates/migrates. */
  store: StoreMode | ((args: ParsedArgs) => StoreMode);
  /** Skip ladder resolution (incl. the `ps` TTY walk) — for hot paths that derive identity themselves. */
  skipIdentity?: boolean;
  /** Nested command-aware disable gating. Defaults to the top-level WRITE_GATED set. */
  writeGated?: boolean | ((args: ParsedArgs) => boolean);
  /** Observer usage metric; a string function permits stable nested command names. */
  usage?: boolean | string | ((args: ParsedArgs) => boolean | string);
}

type StoreMode = "none" | "read" | "touch" | "create";

function isMissingSchemaError(e: unknown): boolean {
  return /no such table:/i.test((e as Error)?.message ?? "");
}

const REGISTRY: Record<string, Handler> = {
  task: { run: task.run, presence: "required", store: "create" },
  claim: { run: claim.runClaim, presence: "required", store: "create" },
  release: { run: claim.runRelease, presence: "required", store: "create" },
  note: { run: note.runNote, presence: "required", store: "create" },
  fact: { run: note.runNote, presence: "required", store: "create" },
  forget: { run: forget.run, presence: "required", store: "create" },
  log: { run: log.run, presence: "required", store: "create" },
  done: { run: done.run, presence: "required", store: "create" },
  status: { run: status.run, presence: "observer", store: "touch" },
  notes: { run: note.runNotes, presence: "observer", store: "touch" },
  facts: { run: note.runNotes, presence: "observer", store: "touch" },
  activity: { run: activity.run, presence: "observer", store: "touch" },
  audit: { run: audit.run, presence: "observer", store: "touch" },
  check: { run: check.run, presence: "observer", store: "touch" },
  preflight: { run: preflight.run, presence: "observer", store: "touch" },
  doctor: { run: doctor.run, presence: "observer", store: "touch" },
  scratchpad: {
    run: scratchpad.run,
    presence: (args) => scratchpad.commandTraits(args).presence,
    store: (args) => scratchpad.commandTraits(args).store,
    writeGated: (args) => scratchpad.commandTraits(args).writeGated,
    usage: (args) => (scratchpad.commandTraits(args).usage ? `scratchpad:${args._[1] ?? "list"}` : false),
  },
  scratchpads: {
    run: async (ctx) => (await import("./commands/dashboard.ts")).runDashboard(ctx),
    presence: "observer",
    store: "create",
  },
  // Viewers intentionally `create`: they poll the store file, so it must exist even before
  // the first agent writes.
  dashboard: {
    run: async (ctx) => (await import("./commands/dashboard.ts")).runDashboard(ctx),
    presence: "observer",
    store: "create",
  },
  view: {
    run: async (ctx) => (await import("./commands/dashboard.ts")).runDashboard(ctx),
    presence: "observer",
    store: "create",
  },
  ui: {
    run: async (ctx) => (await import("./commands/dashboard.ts")).runDashboard(ctx),
    presence: "observer",
    store: "create",
  },
  watch: {
    run: async (ctx) => (await import("./commands/dashboard.ts")).runWatch(ctx),
    presence: "observer",
    store: "create",
  },
  init: { run: init.run, presence: "observer", store: "create" },
  enable: { run: toggle.runEnable, presence: "observer", store: "create" },
  disable: { run: toggle.runDisable, presence: "observer", store: "create" },
  deinit: { run: deinit.run, presence: "observer", store: "touch" },
  config: { run: config.run, presence: "observer", store: "create" },
  upgrade: { run: upgrade.run, presence: "observer", store: "read" },
  uninstall: { run: uninstall.run, presence: "observer", store: "read" },
  // Claude Code hook endpoint — fires on every edit, so it derives identity from the hook
  // payload itself and never creates a store in repos that haven't opted in.
  hook: { run: hook.run, presence: "observer", store: "touch", skipIdentity: true },
};

async function openStoreForMode(
  dbPath: string,
  storeHome: string,
  explicitHome: string | undefined,
  mode: StoreMode,
): Promise<Ctx["store"]> {
  if (mode === "none") return new EmptyStore();
  const location = { explicitHome, defaultHome: storeHome };
  // The default home is Weaver-private and must be secured before any SQLite handle opens.
  // Explicit homes remain caller-managed and are created only for commands that create a store.
  if (explicitHome === undefined) ensureWeaverDir(undefined, storeHome);
  if (mode === "read" || mode === "touch") {
    if (!fs.existsSync(dbPath)) return new EmptyStore();
    if (mode === "touch") {
      try {
        return await openStore(dbPath, { location });
      } catch {
        // Unwritable store (permissions, read-only filesystem): fall through to the read
        // path so observer commands keep working; usage metrics degrade on their own.
      }
    }
    let opened = await openStore(dbPath, { readOnly: true, migrate: false, location });
    try {
      // An older store must be migrated even for readers (queries reference new columns):
      // do a one-time writable open to migrate, then reopen read-only.
      if (Number(opened.getMeta("schema_version") ?? "0") < SCHEMA_VERSION) {
        opened.close();
        (await openStore(dbPath, { location })).close();
        opened = await openStore(dbPath, { readOnly: true, migrate: false, location });
      }
    } catch (e) {
      opened.close();
      if (isMissingSchemaError(e)) return new EmptyStore();
      throw e;
    }
    return opened;
  }
  ensureWeaverDir(explicitHome, storeHome);
  return openStore(dbPath, { location });
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
  write("  scratchpads [--port N] [--no-open] [--open=auto|browser|cmux]  rich Markdown scratchpad UI\n");
  write("  scratchpad <subcommand>                  scriptable scratchpad core (`scratchpad help`)\n");
  write("  task <intent…>                           announce what you're working on\n");
  write("  claim <glob> [--reason …] [--ttl 30m]    stake out an area (exit 1 = recorded, but conflicts exist)\n");
  write("  release <glob>                           free an area\n");
  write(
    "  check <path> [--no-touch]                is anyone else here? (exit 1 on conflict; --no-touch skips heartbeat refresh)\n",
  );
  write("  preflight [paths…|--staged|--upstream|--base REF]  bounded commit/push/PR risk check\n");
  write("  fact <text…> [--pin] [--path …] [--tag …] [--update <id>]  record a durable learning (alias: note)\n");
  write("  facts [query…] [--full] [--all] [--path PATH] [--tag TAG] [--json]  list/search facts (alias: notes)\n");
  write("  forget <id> <why…>                       retire a wrong/obsolete note (--undo <id> restores)\n");
  write("  log <kind> <path> <summary…>             record an activity event\n");
  write("  activity [query…] [--kind K] [--path P] [--since 2h] [--full]  recent activity feed (searchable)\n");
  write("  audit [--json]                           summarize retained usage, setup, and improvements\n");
  write("  done                                     end this session, release its claims\n");
  write("  doctor                                   diagnostics (identity, repo, store)\n");
  write("  dashboard [--port N] [--no-open] [--open=auto|browser|cmux]  alias for scratchpads (also: view, ui)\n");
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
  let storeHolder: StoreHolderHandle | null = null;

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
    const explicitHome = process.env.WEAVER_HOME;
    let storeHome: string | undefined;
    let dbPath: string | undefined;
    if (mode !== "none") {
      try {
        storeHolder = await registerStoreHolder({
          repoId: repo.repoId,
          weaverHome: explicitHome,
          command: first,
        });
      } catch (error) {
        throw new CliError((error as Error).message);
      }
      storeHome = storeHolder.runtime.canonicalHome;
      dbPath = storeHolder.runtime.storePath;
    }
    store = await openStoreForMode(dbPath ?? "", storeHome ?? "", explicitHome, mode);
    const presence = typeof handler.presence === "function" ? handler.presence(args) : handler.presence;
    const resolvedIdentity = handler.skipIdentity ? null : resolveIdentity();
    // An ordinary human terminal can satisfy the TTY rung but is not an attributed agent.
    // Optional commands treat that weak/unknown identity as local-human; explicit and harness
    // identities remain attributable even when their display label is unknown.
    const identity =
      presence === "optional" &&
      resolvedIdentity?.label === "unknown" &&
      (resolvedIdentity.source === "tty" || resolvedIdentity.source === "ancestry")
        ? null
        : resolvedIdentity;
    const now = Date.now();
    const ctx: Ctx = {
      store,
      storeHome,
      storePath: dbPath,
      storeHolder,
      identity,
      callerIdentity: resolvedIdentity,
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
    const gated =
      typeof handler.writeGated === "function"
        ? handler.writeGated(args)
        : (handler.writeGated ?? WRITE_GATED.has(first));
    if (!enabled && gated) {
      err("weaver: disabled for this project (`weaver enable` to resume)\n");
      return 0;
    }
    if (presence !== "observer") {
      if (!identity && presence === "required") {
        err("weaver: couldn't resolve a session identity for this command.\n");
        err("  set WEAVER_SESSION=<stable-id>, or run inside a supported agent harness.\n");
        return 1;
      }
      if (identity) {
        store.upsertSession(
          {
            id: identity.key,
            harness: identity.label,
            idSource: identity.source,
            pid: process.pid,
            cwd: process.cwd(),
            worktreeId: repo.worktreeId,
          },
          now,
        );
      }
    } else if (enabled) {
      const usage =
        typeof handler.usage === "function"
          ? handler.usage(args)
          : (handler.usage ?? (COMMAND_USAGE.has(first) ? first : false));
      if (usage) recordCommandUsage(ctx, typeof usage === "string" ? usage : first);
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
    try {
      await storeHolder?.release();
    } catch {
      /* an exact release failure is reported by destructive handlers; ordinary exit is best effort */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`weaver: unexpected error: ${e?.message ?? e}\n`);
    process.exit(1);
  });
