/** Terse human + JSON rendering for the read paths. Kept compact to stay token-cheap. */

import type { ConflictResult } from "./conflict.ts";
import type { ActivityRow, ClaimRow, NoteRow, SessionRow, Store } from "./store/store.ts";

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
  const core = key.split("@")[0] ?? key;
  const tail = core.split(":").pop() ?? core;
  return tail.length > 6 ? tail.slice(-6) : tail;
}

function who(s: SessionRow): string {
  return `${s.harness}#${shortId(s.id)}`;
}

export function formatConflict(result: ConflictResult, now: number): string {
  const label = result.tier === "hard" ? "CONFLICT (active claim)" : result.tier === "soft" ? "HEADS-UP (recent activity)" : "stale";
  const lines: string[] = [`⚠ ${label} on this area:`];
  for (const h of result.hits) {
    lines.push(`  • ${who(h.session)} — ${h.session.intent ?? "(no stated intent)"}`);
    if (h.claim) lines.push(`      claim: ${h.claim.pattern}${h.claim.reason ? ` — ${h.claim.reason}` : ""} (${ago(now - h.claim.createdAt)})`);
    if (h.activity) lines.push(`      recent: ${h.activity.kind} ${h.activity.target ?? ""}${h.activity.summary ? ` — ${h.activity.summary}` : ""} (${ago(now - h.activity.ts)})`);
    lines.push(`      active ${ago(now - h.session.lastSeen)}`);
  }
  lines.push("  → coordinate, work elsewhere, or ask the user how to split. Don't silently overwrite.");
  return lines.join("\n") + "\n";
}

export interface StatusData {
  sessions: SessionRow[];
  claims: ClaimRow[];
  activity: ActivityRow[];
  notes: NoteRow[];
}

export function formatStatus(d: StatusData, now: number, store: Store): string {
  const out: string[] = [];
  out.push(`${d.sessions.length} other active session${d.sessions.length === 1 ? "" : "s"}`);
  for (const s of d.sessions) {
    out.push(`  ${who(s).padEnd(22)} ${s.intent ?? "(no intent)"}   ${ago(now - s.lastSeen)}`);
  }
  if (d.claims.length) {
    out.push("claims:");
    for (const c of d.claims) {
      const holder = store.getSession(c.sessionId);
      out.push(`  ${c.pattern.padEnd(24)} ${holder ? who(holder) : "?"}${c.reason ? ` — ${c.reason}` : ""}`);
    }
  }
  if (d.activity.length) {
    out.push("recent:");
    for (const a of d.activity) {
      const holder = store.getSession(a.sessionId);
      out.push(`  ${ago(now - a.ts).padStart(7)}  ${(holder?.harness ?? "?").padEnd(11)} ${a.kind} ${a.target ?? ""}${a.summary ? ` — ${a.summary}` : ""}`);
    }
  }
  const notes = d.notes;
  if (notes.length) {
    out.push(`notes (${notes.length}):`);
    for (const n of notes) out.push(`  ${n.pinned ? "📌" : "•"} ${n.body}${n.path ? ` [${n.path}]` : ""}`);
  }
  return out.join("\n") + "\n";
}

export function statusJson(repoId: string, d: StatusData, now: number, store: Store): unknown {
  return {
    repo: repoId,
    sessions: d.sessions.map((s) => ({
      id: s.id,
      harness: s.harness,
      source: s.idSource,
      intent: s.intent,
      lastSeenMsAgo: now - s.lastSeen,
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
