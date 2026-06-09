import type { Ctx } from "../context.ts";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export function run(ctx: Ctx): number {
  const id = ctx.identity;
  const active = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs).length;

  ctx.out("weaver doctor\n");
  ctx.out(
    `identity : ${id ? `${id.key}  (source=${id.source}, harness=${id.label})` : "(unresolved — set WEAVER_SESSION)"}\n`,
  );
  ctx.out(`repo     : ${ctx.repo.repoId}  (basis=${ctx.repo.basis})\n`);
  ctx.out(`root     : ${ctx.repo.root}\n`);
  ctx.out(`binding  : ${isBun ? "bun:sqlite" : "node:sqlite"}\n`);
  ctx.out(`enabled  : ${ctx.store.getMeta("enabled") ?? "1"}\n`);
  ctx.out(`active   : ${active} session(s)\n`);
  return 0;
}
