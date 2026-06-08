import fs from "node:fs";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { removeBlock } from "../instructions/block.ts";
import { instructionTargets, scopeFromFlags } from "../instructions/targets.ts";
import { storePathForRepo } from "../store/location.ts";

export function run(ctx: Ctx): number {
  const flagged = scopeFromFlags(ctx);
  if (flagged === "conflict") {
    ctx.err("weaver: choose either --project or --global, not both.\n");
    return 1;
  }
  const scope = flagged ?? "project";
  const cleaned: string[] = [];
  for (const target of instructionTargets(ctx, scope)) {
    if (!fs.existsSync(target.file)) continue;
    const existing = fs.readFileSync(target.file, "utf8");
    const next = removeBlock(existing);
    if (next !== existing) {
      fs.writeFileSync(target.file, next);
      cleaned.push(target.label);
    }
  }
  ctx.out(`✓ removed Weaver instructions${cleaned.length ? ` from ${cleaned.join(", ")}` : " (none found)"}\n`);

  if (flagBool(ctx.args, "purge")) {
    const dbPath = storePathForRepo(ctx.repo.repoId);
    ctx.store.close(); // release the handle before deleting (dispatcher's close is tolerant)
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
    ctx.out(`✓ purged store at ${dbPath}\n`);
  }
  return 0;
}
