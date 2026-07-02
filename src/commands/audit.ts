import fs from "node:fs";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { hasBlock } from "../instructions/block.ts";
import { type HookStatus, hookStatusForRepo, hookStatusGlobal } from "../instructions/hooks.ts";
import {
  type OpencodePluginStatus,
  opencodePluginStatusForRepo,
  opencodePluginStatusGlobal,
} from "../instructions/opencode.ts";
import { type InstructionScope, instructionTargets } from "../instructions/targets.ts";
import { DEFAULT_ACTIVITY_MAX_EVENTS } from "../store/reap.ts";
import type { ActivityKind, CommandEventRow, NoteRow, SessionRow } from "../store/store.ts";

const AUDIT_LIMIT = DEFAULT_ACTIVITY_MAX_EVENTS;

/** Harness integrations exist at project and global scope; either one makes them effective. */
interface ScopedStatus<T extends string> {
  project: T;
  global: T;
}

interface InstructionCoverage {
  present: number;
  total: number;
  missing: string[];
  error?: string;
}

function instructionCoverage(ctx: Ctx, scope: InstructionScope): InstructionCoverage {
  let targets: ReturnType<typeof instructionTargets>;
  try {
    targets = instructionTargets(ctx, scope);
  } catch (e) {
    return { present: 0, total: 0, missing: [], error: (e as Error)?.message ?? String(e) };
  }
  const present = targets.filter((target) => {
    try {
      return fs.existsSync(target.file) && hasBlock(fs.readFileSync(target.file, "utf8"));
    } catch {
      return false;
    }
  });
  return {
    present: present.length,
    total: targets.length,
    missing: targets.filter((target) => !present.includes(target)).map((target) => target.label),
  };
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isWeakIdentity(session: SessionRow): boolean {
  return session.idSource === "tty" || session.idSource === "ancestry";
}

function tagTokens(note: NoteRow): string[] {
  return (note.tags ?? "")
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function currentNotes(notes: NoteRow[]): NoteRow[] {
  return notes.filter((note) => note.retiredAt === null && !note.superseded);
}

function lastCommandSeen(events: CommandEventRow[], now: number): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const event of events) {
    if (seen[event.command] !== undefined) continue;
    seen[event.command] = now - event.ts;
  }
  return seen;
}

function recommendations(opts: {
  selfWeak: boolean;
  weakSessions: number;
  staleUnended: number;
  expiredOpenClaims: number;
  activityByKind: Record<string, number>;
  currentNotes: NoteRow[];
  commandByName: Record<string, number>;
  project: InstructionCoverage;
  global: InstructionCoverage;
  hooks: ScopedStatus<HookStatus>;
  opencodePlugin: ScopedStatus<OpencodePluginStatus>;
}): string[] {
  const recs: string[] = [];
  const scopedNotes = opts.currentNotes.filter((note) => note.path).length;
  const globalNotes = opts.currentNotes.length - scopedNotes;
  const taggedNotes = opts.currentNotes.filter((note) => tagTokens(note).length > 0).length;

  if (opts.selfWeak) recs.push("Current session identity is weak; set WEAVER_SESSION for critical multi-agent work.");
  if (opts.weakSessions > 0)
    recs.push("Weak tty/ancestry session identities are present; prefer harness IDs or WEAVER_SESSION.");
  if (opts.staleUnended > 0) recs.push("Stale unended sessions exist; agents should call `weaver done` when finished.");
  if (opts.expiredOpenClaims > 0)
    recs.push("Expired open claims exist; they are ignored as active but can make diagnostics noisy.");
  if ((opts.activityByKind.edit ?? 0) === 0)
    recs.push("No edit activity is retained; install Claude Code hooks or use `weaver log` for important edits.");
  if ((opts.commandByName.status ?? 0) === 0)
    recs.push("No `weaver status` usage is recorded yet; agents may not be checking shared context at task start.");
  if ((opts.commandByName.check ?? 0) === 0)
    recs.push("No `weaver check` usage is recorded yet; agents may be relying only on broad claims.");
  if ((opts.commandByName.preflight ?? 0) === 0)
    recs.push("No `weaver preflight` usage is recorded yet; commit/push overlap checks may be missing.");
  if (opts.hooks.project !== "installed" && opts.hooks.global !== "installed")
    recs.push("Claude Code hooks are not installed at project or global scope; run `weaver init --hooks`.");
  if (opts.opencodePlugin.project !== "installed" && opts.opencodePlugin.global !== "installed")
    recs.push(
      "The OpenCode identity plugin is not installed at project or global scope; run `weaver init --hooks` so OpenCode sessions get first-class identity.",
    );
  if (opts.project.present === 0 && opts.global.present === 0)
    recs.push("No Weaver instruction blocks were found; run `weaver init --project` or `weaver init --global`.");
  if (opts.currentNotes.length > 0 && scopedNotes === 0)
    recs.push("All current notes are global; use `weaver note --path` for file or area-specific learnings.");
  else if (globalNotes > scopedNotes)
    recs.push("Most current notes are global; scope new notes with `--path` to reduce agent noise.");
  if (opts.currentNotes.length > 0 && taggedNotes === 0)
    recs.push("No current notes are tagged; use `--tag` for topics agents should filter later.");

  return recs.length ? recs : ["No immediate Weaver usage issues found in retained local data."];
}

function coverageText(coverage: InstructionCoverage): string {
  if (coverage.error) return `error: ${coverage.error}`;
  return `${coverage.present}/${coverage.total}${coverage.missing.length ? ` missing ${coverage.missing.join(", ")}` : ""}`;
}

export function run(ctx: Ctx): number {
  const sessions = ctx.store.listSessions(AUDIT_LIMIT);
  const activeSessions = ctx.store.listActiveSessions(ctx.now, ctx.config.sessionTtlMs);
  const openSessions = ctx.store.listOpenSessions();
  const staleUnended = openSessions.filter((session) => ctx.now - session.lastSeen > ctx.config.sessionTtlMs).length;
  const claims = ctx.store.listClaims(AUDIT_LIMIT);
  const activeClaims = claims.filter((claim) => claim.releasedAt === null && claim.expiresAt > ctx.now).length;
  const expiredOpenClaims = claims.filter((claim) => claim.releasedAt === null && claim.expiresAt <= ctx.now).length;
  const releasedClaims = claims.filter((claim) => claim.releasedAt !== null).length;
  const activity = ctx.store.listRecentActivity(AUDIT_LIMIT);
  const activityByKind = countBy(activity.map((row) => row.kind as ActivityKind));
  const commandEvents = ctx.store.listRecentCommandEvents(AUDIT_LIMIT);
  const commandByName = countBy(commandEvents.map((row) => row.command));
  const notes = ctx.store.listAllNotes(AUDIT_LIMIT);
  const current = currentNotes(notes);
  const project = instructionCoverage(ctx, "project");
  const global = instructionCoverage(ctx, "global");
  const hooks: ScopedStatus<HookStatus> = {
    project: hookStatusForRepo(ctx.repo.root),
    global: hookStatusGlobal(ctx.env),
  };
  const opencodePlugin: ScopedStatus<OpencodePluginStatus> = {
    project: opencodePluginStatusForRepo(ctx.repo.root),
    global: opencodePluginStatusGlobal(ctx.env),
  };
  const weakSessions = sessions.filter(isWeakIdentity).length;
  const selfWeak = ctx.identity?.source === "tty" || ctx.identity?.source === "ancestry";
  const recs = recommendations({
    selfWeak,
    weakSessions,
    staleUnended,
    expiredOpenClaims,
    activityByKind,
    commandByName,
    currentNotes: current,
    project,
    global,
    hooks,
    opencodePlugin,
  });

  const data = {
    repo: ctx.repo.repoId,
    generatedAtMs: ctx.now,
    sessions: {
      total: sessions.length,
      active: activeSessions.length,
      ended: sessions.filter((session) => session.endedAt !== null).length,
      open: openSessions.length,
      staleUnended,
      weakIdentity: weakSessions,
      byHarness: countBy(sessions.map((session) => session.harness)),
      bySource: countBy(sessions.map((session) => session.idSource)),
    },
    claims: {
      total: claims.length,
      active: activeClaims,
      expiredOpen: expiredOpenClaims,
      released: releasedClaims,
    },
    activity: {
      total: activity.length,
      byKind: activityByKind,
      distinctTargets: new Set(activity.map((row) => row.target).filter(Boolean)).size,
    },
    commands: {
      total: commandEvents.length,
      byCommand: commandByName,
      lastSeenMsAgo: lastCommandSeen(commandEvents, ctx.now),
    },
    notes: {
      total: notes.length,
      current: current.length,
      pathScoped: current.filter((note) => note.path).length,
      tagged: current.filter((note) => tagTokens(note).length > 0).length,
      pinned: current.filter((note) => note.pinned).length,
      retired: notes.filter((note) => note.retiredAt !== null).length,
      superseded: notes.filter((note) => note.superseded).length,
    },
    setup: { projectInstructions: project, globalInstructions: global, hooks, opencodePlugin },
    recommendations: recs,
  };

  if (flagBool(ctx.args, "json")) {
    ctx.out(`${JSON.stringify(data)}\n`);
    return 0;
  }

  ctx.out("weaver audit\n");
  ctx.out(
    `sessions : ${data.sessions.total} total, ${data.sessions.active} active, ${data.sessions.staleUnended} stale unended, ${data.sessions.weakIdentity} weak identity\n`,
  );
  ctx.out(
    `claims   : ${data.claims.total} total, ${data.claims.active} active, ${data.claims.expiredOpen} expired open, ${data.claims.released} released\n`,
  );
  ctx.out(
    `activity : ${data.activity.total} retained, ${data.activity.distinctTargets} target(s), ${JSON.stringify(data.activity.byKind)}\n`,
  );
  ctx.out(`commands : ${data.commands.total} retained, ${JSON.stringify(data.commands.byCommand)}\n`);
  ctx.out(
    `notes    : ${data.notes.current} current, ${data.notes.pathScoped} scoped, ${data.notes.tagged} tagged, ${data.notes.pinned} pinned\n`,
  );
  ctx.out(`project  : instructions ${coverageText(project)}\n`);
  ctx.out(`global   : instructions ${coverageText(global)}\n`);
  ctx.out(`hooks    : project ${hooks.project} · global ${hooks.global}\n`);
  ctx.out(`plugin   : project ${opencodePlugin.project} · global ${opencodePlugin.global}\n`);
  ctx.out("\nrecommendations:\n");
  for (const rec of recs) ctx.out(`  - ${rec}\n`);
  return 0;
}
