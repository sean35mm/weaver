import fs from "node:fs";
import path from "node:path";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { removeBlock } from "../instructions/block.ts";
import { storePathForRepo } from "../store/location.ts";

const TARGET_FILES = ["CLAUDE.md", "AGENTS.md"];

export function run(ctx: Ctx): number {
  const cleaned: string[] = [];
  for (const name of TARGET_FILES) {
    const file = path.join(ctx.repo.root, name);
    if (!fs.existsSync(file)) continue;
    const existing = fs.readFileSync(file, "utf8");
    const next = removeBlock(existing);
    if (next !== existing) {
      fs.writeFileSync(file, next);
      cleaned.push(name);
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
