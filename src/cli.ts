#!/usr/bin/env node
/** Weaver CLI entry: parse → bootstrap (repo + store + identity) → dispatch → exit. */

import fs from "node:fs";
import { flagBool, type ParsedArgs, parseArgs } from "./args.ts";
import * as activity from "./commands/activity.ts";
import * as check from "./commands/check.ts";
import * as claim from "./commands/claim.ts";
import * as config from "./commands/config.ts";
import * as dashboard from "./commands/dashboard.ts";
import * as deinit from "./commands/deinit.ts";
import * as doctor from "./commands/doctor.ts";
import * as done from "./commands/done.ts";
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
]);
// Mutating writes that are paused when the project is disabled (done/lifecycle still work).
const WRITE_GATED = new Set(["task", "claim", "release", "note", "log"]);

interface Handler {
  run: (ctx: Ctx) => number | Promise<number>;
  /** Agent/mutating commands require identity and register presence; observers don't. */
  agent: boolean;
  /** `read` never creates a store, `touch` writes only when one exists, `create` creates/migrates. */
  store: StoreMode | ((args: ParsedArgs) => StoreMode);
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
  log: { run: log.run, agent: true, store: "create" },
  done: { run: done.run, agent: true, store: "create" },
  status: { run: status.run, agent: false, store: "read" },
  notes: { run: note.runNotes, agent: false, store: "read" },
  activity: { run: activity.run, agent: false, store: "read" },
  check: { run: check.run, agent: false, store: (args) => (flagBool(args, "no-touch") ? "read" : "touch") },
  preflight: { run: preflight.run, agent: false, store: "read" },
  doctor: { run: doctor.run, agent: false, store: "read" },
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
};

async function openStoreForMode(repoId: string, mode: StoreMode): Promise<Ctx["store"]> {
  const dbPath = storePathForRepo(repoId);
  if (mode === "read") {
    if (!fs.existsSync(dbPath)) return new EmptyStore();
    const opened = await openStore(dbPath, { readOnly: true, migrate: false });
    try {
      opened.getMeta("schema_version");
    } catch (e) {
      opened.close();
      if (isMissingSchemaError(e)) return new EmptyStore();
      throw e;
    }
    return opened;
  }
  if (mode === "touch") {
    return fs.existsSync(dbPath) ? openStore(dbPath) : new EmptyStore();
  }
  ensureWeaverDir();
  return openStore(dbPath);
}

function printHelp(write: (s: string) => void): void {
  write(`weaver ${VERSION} — shared context for coding agents\n\n`);
  write("commands:\n");
  write("  status [--json] [--full]                 who's active, claims, activity, notes\n");
  write("  task <intent…>                           announce what you're working on\n");
  write("  claim <glob> [--reason …] [--ttl 30m]    stake out an area (exit 1 = recorded, but conflicts exist)\n");
  write("  release <glob>                           free an area\n");
  write("  check <path> [--no-touch]                is anyone else here? (exit 1 on conflict)\n");
  write("  preflight [paths…|--staged|--upstream|--base REF]  bounded commit/push/PR risk check\n");
  write("  note <text…> [--pin] [--path …] [--tag …] [--update <id>]  record a durable learning\n");
  write("  notes [--full]                           list notes (with ids; superseded notes hidden)\n");
  write("  log <kind> <path> <summary…>             record an activity event\n");
  write("  activity [--full]                        recent activity feed\n");
  write("  done                                     end this session, release its claims\n");
  write("  doctor                                   diagnostics (identity, repo, store)\n");
  write("  dashboard [--port N] [--no-open]         live web view (Ctrl-C to stop)\n");
  write("  watch                                    live terminal view (Ctrl-C to stop)\n");
  write("\n");
  write("  init [--project|--global]               install agent instructions (this repo, or global = every repo)\n");
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
    const identity = resolveIdentity();
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
