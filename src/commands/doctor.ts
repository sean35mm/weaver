import fs from "node:fs";
import type { Ctx } from "../context.ts";
import { type InstructionBlockStatus, instructionBlockStatus } from "../instructions/block.ts";
import { hookStatusForRepo, hookStatusGlobal } from "../instructions/hooks.ts";
import { opencodePluginStatusForRepo, opencodePluginStatusGlobal } from "../instructions/opencode.ts";
import { type InstructionScope, instructionTargets } from "../instructions/targets.ts";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

interface BlockCoverage {
  current: number;
  total: number;
  outdated: string[];
  missing: string[];
  foreign: string[];
}

function blockCoverage(ctx: Ctx, scope: InstructionScope): BlockCoverage {
  const targets = instructionTargets(ctx, scope);
  const statuses = targets.map((target) => {
    try {
      const contents = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
      return { label: target.label, status: instructionBlockStatus(contents) };
    } catch {
      return { label: target.label, status: "foreign" as InstructionBlockStatus };
    }
  });
  return {
    current: statuses.filter((entry) => entry.status === "current").length,
    total: targets.length,
    outdated: statuses.filter((entry) => entry.status === "outdated").map((entry) => entry.label),
    missing: statuses.filter((entry) => entry.status === "missing").map((entry) => entry.label),
    foreign: statuses.filter((entry) => entry.status === "foreign").map((entry) => entry.label),
  };
}

function coverageLine(coverage: BlockCoverage, scope: InstructionScope): string {
  const details = [
    coverage.outdated.length ? `outdated ${coverage.outdated.join(", ")}` : "",
    coverage.missing.length ? `missing ${coverage.missing.join(", ")}` : "",
    coverage.foreign.length ? `foreign ${coverage.foreign.join(", ")}` : "",
  ].filter(Boolean);
  const guidance: string[] = [];
  if (coverage.outdated.length) guidance.push(`run \`weaver init --${scope}\``);
  if (coverage.foreign.length)
    guidance.push("repair or remove the foreign/incomplete marker first; init will not overwrite it");
  const refresh = guidance.length ? ` — ${guidance.join("; ")}` : "";
  return `${coverage.current}/${coverage.total} current${details.length ? `; ${details.join("; ")}` : ""}${refresh}`;
}

function identityQuality(ctx: Ctx): string {
  const id = ctx.identity;
  if (!id) return "unresolved — set WEAVER_SESSION=<stable-id> or run inside a supported harness";
  if (id.source === "explicit" || id.source === "harness") return "strong";
  return `weak (${id.source}) — session may be reused across terminal lifetimes; set WEAVER_SESSION for critical work`;
}

function integrationLine(
  project: string,
  globalStatus: string,
  integration: string,
  currentStatus = "installed",
): string {
  const line = `project ${project} · global ${globalStatus}`;
  const guidance: string[] = [];
  if (project === "outdated" || project === "partial") guidance.push("run `weaver init --project --hooks`");
  if (globalStatus === "outdated" || globalStatus === "partial") guidance.push("run `weaver init --global --hooks`");
  if (project === "invalid-json") guidance.push("fix project settings JSON, then rerun project init");
  if (globalStatus === "invalid-json") guidance.push("fix global settings JSON, then rerun global init");
  if (project === "foreign") guidance.push("inspect or move the foreign project file; init will not overwrite it");
  if (globalStatus === "foreign") guidance.push("inspect or move the foreign global file; init will not overwrite it");
  if (project !== currentStatus && globalStatus !== currentStatus) {
    if (project === "missing") guidance.push("run `weaver init --project --hooks`");
    if (globalStatus === "missing") guidance.push("run `weaver init --global --hooks`");
  }
  return guidance.length ? `${line} — ${[...new Set(guidance)].join("; ")} for ${integration}` : line;
}

export function run(ctx: Ctx): number {
  const id = ctx.identity;
  const active = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs).length;
  const openSessions = ctx.store.listOpenSessions();
  const staleUnended = openSessions.filter((s) => ctx.now - s.lastSeen > ctx.config.sessionTtlMs).length;
  const openClaims = ctx.store.listOpenClaims();
  const activeClaims = openClaims.filter((c) => c.expiresAt > ctx.now).length;
  const expiredOpenClaims = openClaims.length - activeClaims;
  const scratchpads = ctx.store.listScratchpads(null, 10_000);
  const scratchpadAttachments = ctx.store.listScratchpadAttachments().length;

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
  ctx.out(
    `pads     : ${scratchpads.filter((pad) => pad.state === "active").length} active, ${scratchpads.filter((pad) => pad.state === "archived").length} archived, ${scratchpads.filter((pad) => pad.state === "trash").length} trash, ${scratchpadAttachments} attached\n`,
  );
  ctx.out(`project  : instructions ${coverageLine(blockCoverage(ctx, "project"), "project")}\n`);
  ctx.out(`global   : instructions ${coverageLine(blockCoverage(ctx, "global"), "global")}\n`);
  ctx.out(
    `hooks    : ${integrationLine(
      hookStatusForRepo(ctx.repo.root),
      hookStatusGlobal(ctx.env),
      "Claude Code edit advisories",
    )}\n`,
  );
  ctx.out(
    `plugin   : ${integrationLine(
      opencodePluginStatusForRepo(ctx.repo.root),
      opencodePluginStatusGlobal(ctx.env),
      "OpenCode identity and optional scratchpad/Repository Facts tools",
      "current",
    )}\n`,
  );
  if (opencodePluginStatusForRepo(ctx.repo.root) === "current" && opencodePluginStatusGlobal(ctx.env) === "current") {
    ctx.out(
      "warning  : current OpenCode plugins are installed at both project and global scope; edit and session hooks are invocation-deduplicated, but one scope is sufficient\n",
    );
  }
  return 0;
}
