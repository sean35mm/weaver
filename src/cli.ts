#!/usr/bin/env node
/**
 * Weaver CLI entry. Phase 1 ships the foundations + a read-only `doctor`; the agent-facing
 * verbs (status/task/claim/check/note/log/done/…) arrive in Phase 2.
 */

import { resolveIdentity } from "./identity/session.ts";
import { resolveRepoId } from "./repo/identity.ts";
import { storePathForRepo } from "./store/location.ts";

const VERSION = "0.1.0";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function doctor(): void {
  const id = resolveIdentity();
  const repo = resolveRepoId();
  const storePath = storePathForRepo(repo.repoId);
  const binding = isBun ? "bun:sqlite" : "node:sqlite";

  process.stdout.write(`weaver ${VERSION}\n`);
  process.stdout.write(
    `identity : ${id ? `${id.key}  (source=${id.source}, harness=${id.label})` : "(unresolved — set WEAVER_SESSION)"}\n`,
  );
  process.stdout.write(`repo     : ${repo.repoId}  (basis=${repo.basis})\n`);
  process.stdout.write(`root     : ${repo.root}\n`);
  process.stdout.write(`store    : ${storePath}\n`);
  process.stdout.write(`binding  : ${binding}\n`);
}

const cmd = process.argv[2];
if (cmd === "--version" || cmd === "-v") {
  process.stdout.write(`${VERSION}\n`);
} else if (cmd === "doctor") {
  doctor();
} else {
  process.stdout.write(`weaver ${VERSION} — shared context for coding agents\n`);
  process.stdout.write("Phase 1 (storage + identity foundations). Agent verbs land in Phase 2.\n");
  process.stdout.write("Try: weaver doctor\n");
}
