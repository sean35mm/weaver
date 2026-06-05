/** Terse human + JSON rendering for the read paths. Kept compact to stay token-cheap. */

import { createHash } from "node:crypto";
import type { ConflictResult } from "./conflict.ts";
import type { ActivityRow, ClaimRow, NoteRow, SessionRow, Store } from "./store/store.ts";
import { plainTheme, type TerminalTheme } from "./terminal/color.ts";

/** Claims whose holder is currently live — so a crashed agent's claim doesn't look active. */
export function claimsByLiveHolders(claims: ClaimRow[], live: SessionRow[]): ClaimRow[] {
  const ids = new Set(live.map((s) => s.id));
  return claims.filter((c) => ids.has(c.sessionId));
}

export function ago(ms: number): string {
  const v = Math.max(0, ms);
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Short, stable token for disambiguating same-harness sessions in output. */
export function shortId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 6);
}

function who(s: SessionRow): string {
  return `${s.harness}#${shortId(s.id)}`;
}

export function formatConflict(result: ConflictResult, now: number, theme: TerminalTheme = plainTheme): string {
  const label = result.tier === "hard" ? "CONFLICT (active claim)" : result.tier === "soft" ? "HEADS-UP (recent activity)" : "stale";
  const lines: string[] = [`⚠ ${theme.severity(result.tier, label)} ${theme.dim("on this area:")}`];
  for (const h of result.hits) {
    lines.push(`  ${theme.dim("•")} ${theme.accent(who(h.session))} ${theme.dim("—")} ${h.session.intent ?? theme.dim("(no stated intent)")}`);
    if (h.claim) lines.push(`      ${theme.dim("claim:")} ${theme.path(h.claim.pattern)}${h.claim.reason ? ` ${theme.dim("—")} ${h.claim.reason}` : ""} ${theme.dim(`(${ago(now - h.claim.createdAt)})`)}`);
    if (h.activity) lines.push(`      ${theme.dim("recent:")} ${theme.kind(h.activity.kind)} ${h.activity.target ? theme.path(h.activity.target) : ""}${h.activity.summary ? ` ${theme.dim("—")} ${h.activity.summary}` : ""} ${theme.dim(`(${ago(now - h.activity.ts)})`)}`);
    lines.push(`      ${theme.dim(`active ${ago(now - h.session.lastSeen)}`)}`);
  }
  lines.push(theme.dim("  → coordinate, work elsewhere, or ask the user how to split. Don't silently overwrite."));
  return lines.join("\n") + "\n";
}

export interface StatusData {
  sessions: SessionRow[];
  completed: SessionRow[];
  claims: ClaimRow[];
  activity: ActivityRow[];
  notes: NoteRow[];
}

export function formatStatus(d: StatusData, now: number, store: Store, theme: TerminalTheme = plainTheme): string {
  const out: string[] = [];
  out.push(d.sessions.length ? `${theme.accent(String(d.sessions.length))} other active session${d.sessions.length === 1 ? "" : "s"}` : `${theme.success("weaver:")} no other active agents`);
  for (const s of d.sessions) {
    out.push(`  ${theme.accent(who(s).padEnd(22))} ${s.intent ?? theme.dim("(no intent)")}   ${theme.dim(ago(now - s.lastSeen))}`);
  }
  if (d.completed.length) {
    out.push(theme.heading("recently done:"));
    for (const s of d.completed) {
      out.push(`  ${theme.dim(who(s).padEnd(22))} ${s.intent ?? theme.dim("(no intent)")}   ${theme.dim(ago(now - (s.endedAt ?? s.lastSeen)))}`);
    }
  }
  if (d.claims.length) {
    out.push(theme.heading("claims:"));
    for (const c of d.claims) {
      const holder = store.getSession(c.sessionId);
      out.push(`  ${theme.path(c.pattern.padEnd(24))} ${holder ? theme.accent(who(holder)) : theme.dim("?")}${c.reason ? ` ${theme.dim("—")} ${c.reason}` : ""}`);
    }
  }
  if (d.activity.length) {
    out.push(theme.heading("recent:"));
    for (const a of d.activity) {
      const holder = store.getSession(a.sessionId);
      out.push(`  ${theme.dim(ago(now - a.ts).padStart(7))}  ${theme.accent((holder?.harness ?? "?").padEnd(11))} ${theme.kind(a.kind)} ${a.target ? theme.path(a.target) : ""}${a.summary ? ` ${theme.dim("—")} ${a.summary}` : ""}`);
    }
  }
  const notes = d.notes;
  if (notes.length) {
    out.push(theme.heading(`notes (${notes.length}):`));
    for (const n of notes) out.push(`  ${n.pinned ? theme.pin("📌") : theme.dim("•")} ${n.body}${n.path ? ` ${theme.dim("[")}${theme.path(n.path)}${theme.dim("]")}` : ""}`);
  }
  return out.join("\n") + "\n";
}

export function statusJson(repoId: string, d: StatusData, now: number, store: Store): unknown {
  return {
    repo: repoId,
    sessions: d.sessions.map((s) => ({
      shortId: shortId(s.id),
      harness: s.harness,
      source: s.idSource,
      intent: s.intent,
      lastSeenMsAgo: now - s.lastSeen,
    })),
    completed: d.completed.map((s) => ({
      shortId: shortId(s.id),
      harness: s.harness,
      source: s.idSource,
      intent: s.intent,
      endedMsAgo: now - (s.endedAt ?? s.lastSeen),
    })),
    claims: d.claims.map((c) => ({
      pattern: c.pattern,
      reason: c.reason,
      by: store.getSession(c.sessionId)?.harness ?? null,
      createdMsAgo: now - c.createdAt,
    })),
    recentActivity: d.activity.map((a) => ({
      kind: a.kind,
      target: a.target,
      summary: a.summary,
      by: store.getSession(a.sessionId)?.harness ?? null,
      tsMsAgo: now - a.ts,
    })),
    notes: d.notes.map((n) => ({ body: n.body, path: n.path, pinned: n.pinned })),
  };
}
