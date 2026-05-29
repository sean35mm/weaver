#!/usr/bin/env node
/** Weaver CLI entry: parse → bootstrap (repo + store + identity) → dispatch → exit. */

import { parseArgs } from "./args.ts";
import * as activity from "./commands/activity.ts";
import * as claim from "./commands/claim.ts";
import * as check from "./commands/check.ts";
import * as doctor from "./commands/doctor.ts";
import * as done from "./commands/done.ts";
import * as log from "./commands/log.ts";
import * as note from "./commands/note.ts";
import * as status from "./commands/status.ts";
import * as task from "./commands/task.ts";
import type { Ctx } from "./context.ts";
import { resolveIdentity } from "./identity/session.ts";
import { resolveRepoId } from "./repo/identity.ts";
import { ensureWeaverDir, storePathForRepo } from "./store/location.ts";
import { openStore } from "./store/open.ts";
import { CliError } from "./validate.ts";

const VERSION = "0.1.0";
const BOOLEAN_FLAGS = new Set(["pin", "json", "full", "version", "help", "v", "purge", "exclusive"]);

interface Handler {
  run: (ctx: Ctx) => number;
  /** Agent/mutating commands require identity and register presence; observers don't. */
  agent: boolean;
}

const REGISTRY: Record<string, Handler> = {
  task: { run: task.run, agent: true },
  claim: { run: claim.runClaim, agent: true },
  release: { run: claim.runRelease, agent: true },
  note: { run: note.runNote, agent: true },
  log: { run: log.run, agent: true },
  done: { run: done.run, agent: true },
  status: { run: status.run, agent: false },
  notes: { run: note.runNotes, agent: false },
  activity: { run: activity.run, agent: false },
  check: { run: check.run, agent: false },
  doctor: { run: doctor.run, agent: false },
};

function printHelp(write: (s: string) => void): void {
  write(`weaver ${VERSION} — shared context for coding agents\n\n`);
  write("commands:\n");
  write("  status [--json] [--full]                 who's active, claims, activity, notes\n");
  write("  task <intent…>                           announce what you're working on\n");
  write("  claim <glob> [--reason …] [--ttl 30m]    stake out an area (surfaces overlaps)\n");
  write("  release <glob>                           free an area\n");
  write("  check <path>                             is anyone else here? (exit 1 on conflict)\n");
  write("  note <text…> [--pin] [--path …] [--tag …]  record a durable learning\n");
  write("  notes [--full]                           list notes\n");
  write("  log <kind> <path> <summary…>             record an activity event\n");
  write("  activity [--full]                        recent activity feed\n");
  write("  done                                     end this session, release its claims\n");
  write("  doctor                                   diagnostics (identity, repo, store)\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const out = (s: string): void => void process.stdout.write(s);
  const err = (s: string): void => void process.stderr.write(s);

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

  const args = parseArgs(argv, BOOLEAN_FLAGS);
  const repo = resolveRepoId();
  ensureWeaverDir();
  const store = await openStore(storePathForRepo(repo.repoId));
  const identity = resolveIdentity();
  const now = Date.now();
  const ctx: Ctx = {
    store,
    identity,
    repo,
    cwd: process.cwd(),
    now,
    env: process.env as Record<string, string | undefined>,
    args,
    out,
    err,
  };

  try {
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
    return handler.run(ctx);
  } catch (e) {
    if (e instanceof CliError) {
      err(`weaver: ${e.message}\n`);
      return e.code;
    }
    err(`weaver: unexpected error: ${(e as Error)?.message ?? e}\n`);
    return 1;
  } finally {
    store.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`weaver: fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
