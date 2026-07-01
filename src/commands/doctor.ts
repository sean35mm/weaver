import fs from "node:fs";
import type { Ctx } from "../context.ts";
import { hasBlock } from "../instructions/block.ts";
import { hookStatusForRepo } from "../instructions/hooks.ts";
import { type InstructionScope, instructionTargets } from "../instructions/targets.ts";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function blockCoverage(ctx: Ctx, scope: InstructionScope): string {
  const targets = instructionTargets(ctx, scope);
  const present = targets.filter((target) => {
    try {
      return fs.existsSync(target.file) && hasBlock(fs.readFileSync(target.file, "utf8"));
    } catch {
      return false;
    }
  });
  const missing = targets.filter((target) => !present.includes(target)).map((target) => target.label);
  return `${present.length}/${targets.length}${missing.length ? ` missing ${missing.join(", ")}` : ""}`;
}

function identityQuality(ctx: Ctx): string {
  const id = ctx.identity;
  if (!id) return "unresolved — set WEAVER_SESSION=<stable-id> or run inside a supported harness";
  if (id.source === "explicit" || id.source === "harness") return "strong";
  return `weak (${id.source}) — session may be reused across terminal lifetimes; set WEAVER_SESSION for critical work`;
}

function hookHint(status: ReturnType<typeof hookStatusForRepo>): string {
  if (status === "installed") return "installed";
  if (status === "partial") return "partial — re-run `weaver init --project --hooks`";
  if (status === "invalid-json")
    return "invalid JSON — fix .claude/settings.json, then re-run `weaver init --project --hooks`";
  return "missing — run `weaver init --project --hooks` to enable Claude Code edit advisories";
}

export function run(ctx: Ctx): number {
  const id = ctx.identity;
  const active = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs).length;
  const openSessions = ctx.store.listOpenSessions();
  const staleUnended = openSessions.filter((s) => ctx.now - s.lastSeen > ctx.config.sessionTtlMs).length;
  const openClaims = ctx.store.listOpenClaims();
  const activeClaims = openClaims.filter((c) => c.expiresAt > ctx.now).length;
  const expiredOpenClaims = openClaims.length - activeClaims;

  ctx.out("weaver doctor\n");
  ctx.out(
    `identity : ${id ? `${id.key}  (source=${id.source}, harness=${id.label})` : "(unresolved — set WEAVER_SESSION)"}\n`,
  );
  ctx.out(`quality  : ${identityQuality(ctx)}\n`);
  ctx.out(`repo     : ${ctx.repo.repoId}  (basis=${ctx.repo.basis})\n`);
  ctx.out(`root     : ${ctx.repo.root}\n`);
  ctx.out(`binding  : ${isBun ? "bun:sqlite" : "node:sqlite"}\n`);
  ctx.out(`enabled  : ${ctx.store.getMeta("enabled") ?? "1"}\n`);
  ctx.out(`active   : ${active} session(s)\n`);
  ctx.out(`stale    : ${staleUnended} unended session(s)\n`);
  ctx.out(`claims   : ${activeClaims} active, ${expiredOpenClaims} expired open\n`);
  ctx.out(`project  : instructions ${blockCoverage(ctx, "project")}\n`);
  ctx.out(`global   : instructions ${blockCoverage(ctx, "global")}\n`);
  ctx.out(`hooks    : ${hookHint(hookStatusForRepo(ctx.repo.root))}\n`);
  return 0;
}
