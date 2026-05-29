import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { injectBlock } from "../instructions/block.ts";
import { storePathForRepo } from "../store/location.ts";

const TARGET_FILES = ["CLAUDE.md", "AGENTS.md"];

export function run(ctx: Ctx): number {
  ctx.store.setMeta("enabled", "1");
  ctx.store.setMeta("repo_id", ctx.repo.repoId);

  const wrote: string[] = [];
  const unchanged: string[] = [];
  for (const name of TARGET_FILES) {
    const file = path.join(ctx.repo.root, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = injectBlock(existing);
    if (next !== existing) {
      fs.writeFileSync(file, next);
      wrote.push(name);
    } else {
      unchanged.push(name);
    }
  }

  ctx.out("✓ weaver initialized for this repo\n");
  ctx.out(`  repo  : ${ctx.repo.repoId} (${ctx.repo.basis})\n`);
  ctx.out(`  store : ${storePathForRepo(ctx.repo.repoId)}\n`);
  if (wrote.length) ctx.out(`  wrote : ${wrote.join(", ")}\n`);
  if (unchanged.length) ctx.out(`  ok    : ${unchanged.join(", ")} (already current)\n`);
  return 0;
}
