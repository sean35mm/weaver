import { execFileSync } from "node:child_process";
import { flagBool, flagStr } from "../args.ts";
import type { Ctx } from "../context.ts";
import { ago, shortId } from "../render.ts";
import { normalizeTarget } from "../repo/paths.ts";
import { hasBroadClaim, runPreflight, type PreflightResult, type PreflightSeverity } from "../preflight.ts";
import type { ConflictHit } from "../conflict.ts";
import type { SessionRow } from "../store/store.ts";
import { CliError } from "../validate.ts";

type Source = "paths" | "staged" | "upstream" | "base";
type FailOn = "never" | "hard" | "soft";
const OUTPUT_LIMIT = 20;

interface PathSource {
  source: Source;
  paths: string[];
}

interface RenderOpts {
  operation: string;
  source: Source;
  failOn: FailOn;
  full: boolean;
}

function git(cwd: string, args: string[], message: string): string {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    throw new CliError(message, 2);
  }
}

export function parseNameStatus(output: string): string[] {
  const parts = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    if (status.startsWith("R")) {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else if (status.startsWith("C")) {
      i++; // source path is unchanged; only the copy destination is relevant.
      const newPath = parts[++i];
      if (newPath) paths.push(newPath);
    } else {
      const p = parts[++i];
      if (p) paths.push(p);
    }
  }
  return [...new Set(paths)];
}

function diffPaths(ctx: Ctx, refArgs: string[], message: string): string[] {
  const out = git(ctx.repo.root, ["diff", "--name-status", "-z", "--find-renames", ...refArgs], message);
  return parseNameStatus(out).map((p) => normalizePreflightTarget(p, ctx, ctx.repo.root));
}

function sourceCount(ctx: Ctx): number {
  return [ctx.args._.length > 1, flagBool(ctx.args, "staged"), flagBool(ctx.args, "upstream"), ctx.args.flags.base !== undefined].filter(Boolean).length;
}

function normalizePreflightTarget(target: string, ctx: Ctx, cwd: string = ctx.cwd): string {
  try {
    return normalizeTarget(target, ctx.repo.root, cwd);
  } catch (e) {
    if (e instanceof CliError) throw new CliError(e.message, 2);
    throw e;
  }
}

function collectPaths(ctx: Ctx): PathSource {
  const count = sourceCount(ctx);
  if (count === 0) throw new CliError("preflight needs paths, --staged, --upstream, or --base <ref>", 2);
  if (count > 1) throw new CliError("choose only one path source: paths, --staged, --upstream, or --base", 2);

  const positional = ctx.args._.slice(1);
  if (positional.length) {
    return { source: "paths", paths: positional.map((p) => normalizePreflightTarget(p, ctx)) };
  }
  if (flagBool(ctx.args, "staged")) {
    return { source: "staged", paths: diffPaths(ctx, ["--cached"], "could not inspect staged changes") };
  }
  if (flagBool(ctx.args, "upstream")) {
    git(ctx.repo.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], "could not resolve upstream; use --base <ref> or explicit paths");
    return { source: "upstream", paths: diffPaths(ctx, ["@{upstream}...HEAD"], "could not inspect upstream diff") };
  }

  const base = ctx.args.flags.base;
  if (typeof base !== "string") throw new CliError("missing --base <ref>", 2);
  return { source: "base", paths: diffPaths(ctx, [`${base}...HEAD`], `could not inspect diff against ${base}`) };
}

function parseFailOn(raw: string | undefined): FailOn {
  const value = raw ?? "soft";
  if (value === "never" || value === "hard" || value === "soft") return value;
  throw new CliError("--fail-on must be one of: never, hard, soft", 2);
}

function shouldFail(severity: PreflightSeverity, failOn: FailOn): boolean {
  if (failOn === "never") return false;
  if (failOn === "hard") return severity === "hard";
  return severity === "hard" || severity === "soft";
}

function who(session: SessionRow): string {
  return `${session.harness}#${shortId(session.id)}`;
}

function hitSummary(hit: ConflictHit, now: number): string {
  const broad = hasBroadClaim(hit) ? " [broad]" : "";
  if (hit.claim) {
    return `${who(hit.session)} claims ${hit.claim.pattern}${broad}${hit.claim.reason ? ` — ${hit.claim.reason}` : ""}; active ${ago(now - hit.session.lastSeen)}`;
  }
  if (hit.activity) {
    return `${who(hit.session)} recent ${hit.activity.kind} ${hit.activity.target ?? ""}${hit.activity.summary ? ` — ${hit.activity.summary}` : ""}; active ${ago(now - hit.session.lastSeen)}`;
  }
  return `${who(hit.session)} — ${hit.session.intent ?? "(no stated intent)"}; active ${ago(now - hit.session.lastSeen)}`;
}

function capped<T>(items: T[], full: boolean): T[] {
  return full ? items : items.slice(0, OUTPUT_LIMIT);
}

function truncatedCount(items: unknown[], full: boolean): number {
  return full ? 0 : Math.max(0, items.length - OUTPUT_LIMIT);
}

function formatHuman(result: PreflightResult, opts: RenderOpts, now: number): string {
  const lines: string[] = [];
  const label = result.severity === "hard" ? "hard overlap" : result.severity === "soft" ? "soft overlap" : result.severity === "info" ? "info" : "no relevant overlaps";
  lines.push(`weaver preflight: ${label} before ${opts.operation}`);
  lines.push(`checked ${result.paths.length} path${result.paths.length === 1 ? "" : "s"} from ${opts.source}`);

  for (const warning of result.warnings) lines.push(`warning: ${warning}`);

  for (const conflict of capped(result.conflicts, opts.full)) {
    lines.push("");
    lines.push(`${conflict.path}`);
    for (const hit of conflict.hits) lines.push(`  ${conflict.tier}: ${hitSummary(hit, now)}`);
  }
  if (!opts.full && result.conflicts.length > 20) lines.push(`... ${result.conflicts.length - 20} more conflicting path(s); rerun with --full`);

  if (result.stale.length) {
    lines.push("");
    lines.push("stale overlaps treated as free:");
    for (const stale of capped(result.stale, opts.full)) lines.push(`  ${stale.path}`);
    if (!opts.full && result.stale.length > 20) lines.push(`  ... ${result.stale.length - 20} more stale path(s); rerun with --full`);
  }

  if (result.unrelatedSessions.length) {
    lines.push("");
    lines.push(`${result.unrelatedSessions.length} other active session${result.unrelatedSessions.length === 1 ? "" : "s"} do not overlap checked paths.`);
  }

  lines.push("");
  if (result.recommendation === "ask-user") {
    lines.push("Recommendation: ask the user whether to continue, wait briefly, or coordinate first. Do not silently wait for another session.");
  } else {
    lines.push("Recommendation: continue; no relevant active overlap was found.");
  }
  lines.push(`exit policy: fail-on=${opts.failOn}`);
  return lines.join("\n") + "\n";
}

function jsonHit(hit: ConflictHit, now: number): unknown {
  return {
    session: {
      shortId: shortId(hit.session.id),
      harness: hit.session.harness,
      source: hit.session.idSource,
      intent: hit.session.intent,
      lastSeenMsAgo: now - hit.session.lastSeen,
    },
    claim: hit.claim
      ? { pattern: hit.claim.pattern, reason: hit.claim.reason, broad: hasBroadClaim(hit), createdMsAgo: now - hit.claim.createdAt }
      : null,
    activity: hit.activity
      ? { kind: hit.activity.kind, target: hit.activity.target, summary: hit.activity.summary, tsMsAgo: now - hit.activity.ts }
      : null,
  };
}

function formatJson(result: PreflightResult, opts: RenderOpts, now: number): string {
  const paths = capped(result.paths, opts.full);
  const conflicts = capped(result.conflicts, opts.full);
  const stale = capped(result.stale, opts.full);
  const unrelatedSessions = capped(result.unrelatedSessions, opts.full);
  return (
    JSON.stringify({
      operation: opts.operation,
      source: opts.source,
      failOn: opts.failOn,
      severity: result.severity,
      recommendation: result.recommendation,
      counts: {
        paths: result.paths.length,
        conflicts: result.conflicts.length,
        stale: result.stale.length,
        unrelatedSessions: result.unrelatedSessions.length,
      },
      truncated: {
        paths: truncatedCount(result.paths, opts.full),
        conflicts: truncatedCount(result.conflicts, opts.full),
        stale: truncatedCount(result.stale, opts.full),
        unrelatedSessions: truncatedCount(result.unrelatedSessions, opts.full),
      },
      paths,
      conflicts: conflicts.map((c) => ({ path: c.path, tier: c.tier, hits: c.hits.map((h) => jsonHit(h, now)) })),
      stale: stale.map((c) => ({ path: c.path, tier: c.tier, hits: c.hits.map((h) => jsonHit(h, now)) })),
      unrelatedSessions: unrelatedSessions.map((s) => ({ shortId: shortId(s.id), harness: s.harness, source: s.idSource, intent: s.intent, lastSeenMsAgo: now - s.lastSeen })),
      warnings: result.warnings,
    }) + "\n"
  );
}

export function run(ctx: Ctx): number {
  const pathSource = collectPaths(ctx);
  const failOn = parseFailOn(flagStr(ctx.args, "fail-on"));
  const operation = flagStr(ctx.args, "operation") ?? "operation";
  const result = runPreflight({
    store: ctx.store,
    paths: pathSource.paths,
    selfId: ctx.identity?.key ?? null,
    now: ctx.now,
    sessionTtlMs: ctx.config.sessionTtlMs,
    recentMs: ctx.config.recentMs,
  });
  const renderOpts = { operation, source: pathSource.source, failOn, full: flagBool(ctx.args, "full") };
  ctx.out(flagBool(ctx.args, "json") ? formatJson(result, renderOpts, ctx.now) : formatHuman(result, renderOpts, ctx.now));
  return shouldFail(result.severity, failOn) ? 1 : 0;
}
