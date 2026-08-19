/** Terse human + JSON rendering for the read paths. Kept compact to stay token-cheap. */

import { createHash } from "node:crypto";
import type { ConflictHit, ConflictResult } from "./conflict.ts";
import type {
  ActivityRow,
  ClaimRow,
  NoteRow,
  ScratchpadAttachmentRow,
  ScratchpadRow,
  SessionRow,
  Store,
} from "./store/store.ts";
import { plainTheme, type TerminalTheme } from "./terminal/color.ts";
import { padEndVisible, terminalWidth, truncateVisible, visibleLength, wrapWithPrefix } from "./terminal/format.ts";

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

interface FormatOptions {
  width?: number;
}

const NOTE_WIDTH = 100;
const NOTE_CONTINUATION_INDENT = "      ";

type SessionLike = Pick<SessionRow, "id" | "harness" | "idSource">;

/** Explicit sessions display the name the caller chose (`WEAVER_SESSION=alice` → "alice"). */
export function sessionName(s: SessionLike): string {
  if (s.idSource === "explicit" && s.id.startsWith("explicit:")) {
    const start = "explicit:".length;
    const at = s.id.lastIndexOf("@");
    const name = at > start ? s.id.slice(start, at) : s.id.slice(start);
    if (name) return name;
  }
  return s.harness;
}

/** Explicit names are unique per host by construction, so they need no hash suffix. */
export function who(s: SessionLike): string {
  return s.idSource === "explicit" ? sessionName(s) : `${s.harness}#${shortId(s.id)}`;
}

/** Non-sensitive checkout label for UI and JSON; absolute roots never leave identity resolution. */
export function worktreeLabel(worktreeId: string | null | undefined): string {
  return worktreeId ? `wt-${worktreeId.slice(0, 6)}` : "unknown";
}

function appendWrapped(
  lines: string[],
  prefix: string,
  text: string,
  width: number,
  continuationIndent?: string,
): void {
  lines.push(...wrapWithPrefix(prefix, text, width, continuationIndent));
}

function pushSection(lines: string[], heading: string): void {
  if (lines.length && lines.at(-1) !== "") lines.push("");
  lines.push(heading);
}

function compactRow(label: string, body: string, suffix: string, width: number): string {
  const maxBody = Math.max(8, width - visibleLength(label) - visibleLength(suffix));
  return `${label}${truncateVisible(body, maxBody)}${suffix}`;
}

function truncateWithSuffix(text: string, width: number, suffix: string): string {
  if (visibleLength(text) <= width) return text;
  const suffixText = ` ${suffix}`;
  const suffixWidth = visibleLength(suffixText);
  if (suffixWidth >= width - 8) return truncateVisible(text, width);
  return `${truncateVisible(text, width - suffixWidth)}${suffixText}`;
}

export function formatConflict(
  result: ConflictResult,
  now: number,
  theme: TerminalTheme = plainTheme,
  opts: FormatOptions = {},
): string {
  const width = terminalWidth(opts.width);
  const label =
    result.tier === "hard"
      ? "CONFLICT (active claim)"
      : result.tier === "soft"
        ? "HEADS-UP (recent activity)"
        : "stale";
  const lines: string[] = [`⚠ ${theme.severity(result.tier, label)} ${theme.dim("on this area:")}`];
  for (const h of result.hits) {
    appendWrapped(
      lines,
      `  ${theme.dim("•")} ${theme.accent(who(h.session))} ${theme.dim("—")} `,
      h.session.intent ?? theme.dim("(no stated intent)"),
      width,
      "      ",
    );
    if (h.claim) {
      appendWrapped(
        lines,
        `      ${theme.dim("claim:")} `,
        `${theme.path(h.claim.pattern)}${h.claim.reason ? ` ${theme.dim("—")} ${h.claim.reason}` : ""} ${theme.dim(`(${ago(now - h.claim.createdAt)})`)}`,
        width,
      );
    }
    if (h.activity) {
      appendWrapped(
        lines,
        `      ${theme.dim("recent:")} `,
        `${theme.kind(h.activity.kind)} ${h.activity.target ? theme.path(h.activity.target) : ""}${h.activity.summary ? ` ${theme.dim("—")} ${h.activity.summary}` : ""} ${theme.dim(`(${ago(now - h.activity.ts)})`)}`,
        width,
      );
    }
    lines.push(`      ${theme.dim(`active ${ago(now - h.session.lastSeen)}`)}`);
  }
  appendWrapped(
    lines,
    theme.dim("  → "),
    theme.dim("coordinate, work elsewhere, or ask the user how to split. Don't silently overwrite."),
    width,
  );
  return lines.join("\n") + "\n";
}

export function formatInformationalConflict(
  hits: ConflictHit[],
  now: number,
  theme: TerminalTheme = plainTheme,
): string {
  const lines = [`ℹ ${theme.severity("info", "OTHER WORKTREE")} ${theme.dim("on this area:")}`];
  for (const hit of hits) {
    const target = hit.claim?.pattern ?? hit.activity?.target ?? "";
    lines.push(
      `  ${theme.dim("•")} ${theme.accent(who(hit.session))} ${theme.dim("—")} ${target ? theme.path(target) : ""} ${theme.dim(`(${worktreeLabel(hit.claim?.worktreeId ?? hit.activity?.worktreeId)})`)}`,
    );
    lines.push(`      ${theme.dim(`active ${ago(now - hit.session.lastSeen)}`)}`);
  }
  lines.push(
    theme.dim("  → files are isolated in another checkout; continue and coordinate integration later if needed."),
  );
  return lines.join("\n") + "\n";
}

export interface StatusData {
  sessions: SessionRow[];
  completed: SessionRow[];
  claims: ClaimRow[];
  activity: ActivityRow[];
  notes: NoteRow[];
  /** Active summaries only; consumers must never surface `body` from status. */
  scratchpads?: ScratchpadRow[];
  scratchpadAttachments?: ScratchpadAttachmentRow[];
}

export function formatStatus(
  d: StatusData,
  now: number,
  store: Store,
  theme: TerminalTheme = plainTheme,
  opts: FormatOptions = {},
): string {
  const width = terminalWidth(opts.width);
  const out: string[] = [];
  out.push(
    d.sessions.length
      ? `${theme.accent(String(d.sessions.length))} other active session${d.sessions.length === 1 ? "" : "s"}`
      : `${theme.success("weaver:")} no other active agents`,
  );
  for (const s of d.sessions) {
    const label = `  ${padEndVisible(theme.accent(who(s)), 22)} `;
    out.push(
      compactRow(
        label,
        s.intent ?? theme.dim("(no intent)"),
        ` ${theme.dim(worktreeLabel(s.worktreeId))} ${theme.dim(ago(now - s.lastSeen))}`,
        width,
      ),
    );
  }
  if (d.activity.length) {
    pushSection(out, theme.heading("recent:"));
    for (const a of d.activity) {
      const holder = store.getSession(a.sessionId);
      const prefix = `  ${theme.dim(ago(now - a.ts).padStart(7))}  ${padEndVisible(theme.accent(holder ? sessionName(holder) : "?"), 11)} ${theme.kind(a.kind)} `;
      const body = `${a.target ? theme.path(a.target) : ""}${a.summary ? `${a.target ? " " : ""}${theme.dim("—")} ${a.summary}` : ""}`;
      if (a.kind === "note") {
        const maxBody = Math.max(8, width - visibleLength(prefix));
        out.push(body ? `${prefix}${truncateWithSuffix(body, maxBody, theme.dim("(see notes)"))}` : prefix.trimEnd());
        continue;
      }
      appendWrapped(out, prefix, body, width);
    }
  }
  if (d.claims.length) {
    pushSection(out, theme.heading("claims:"));
    for (const c of d.claims) {
      const holder = store.getSession(c.sessionId);
      const base = `  ${padEndVisible(theme.path(c.pattern), 24)} ${holder ? theme.accent(who(holder)) : theme.dim("?")} ${theme.dim(worktreeLabel(c.worktreeId))}`;
      if (c.reason) appendWrapped(out, `${base} ${theme.dim("—")} `, c.reason, width);
      else out.push(base);
    }
  }
  const scratchpads = d.scratchpads ?? [];
  const attachments = d.scratchpadAttachments ?? [];
  if (scratchpads.length) {
    pushSection(out, theme.heading(`scratchpads (${scratchpads.length} active):`));
    for (const pad of scratchpads) {
      const attached = attachments.filter((entry) => entry.scratchpadId === pad.id);
      const names = attached
        .map((entry) => store.getSession(entry.sessionId))
        .filter((session): session is SessionRow => Boolean(session))
        .map(who);
      const suffix = `${theme.dim(`r${pad.revision}`)}${names.length ? ` ${theme.dim("—")} ${names.join(", ")}` : ""}`;
      appendWrapped(out, `  ${theme.accent(`#${pad.id}`)} `, `${pad.title} ${suffix}`, width);
    }
  }
  if (d.completed.length) {
    pushSection(out, theme.heading("recently done:"));
    for (const s of d.completed) {
      const label = `  ${padEndVisible(theme.dim(who(s)), 22)} `;
      out.push(
        compactRow(
          label,
          s.intent ?? theme.dim("(no intent)"),
          `   ${theme.dim(ago(now - (s.endedAt ?? s.lastSeen)))}`,
          width,
        ),
      );
    }
  }
  const notes = d.notes;
  if (notes.length) {
    pushSection(out, theme.heading(`notes (${notes.length}):`));
    const noteWidth = Math.min(width, NOTE_WIDTH);
    const rendered = notes.map((n) => {
      const prefix = `  ${n.pinned ? theme.pin("📌") : theme.dim("•")} `;
      const body = `${n.body}${n.path ? ` ${theme.dim("[")}${theme.path(n.path)}${theme.dim("]")}` : ""}`;
      return wrapWithPrefix(prefix, body, noteWidth, NOTE_CONTINUATION_INDENT);
    });
    const spaceNotes = rendered.some((lines) => lines.length > 1);
    for (let i = 0; i < rendered.length; i++) {
      if (i > 0 && spaceNotes) out.push("");
      out.push(...rendered[i]!);
    }
  }
  return out.join("\n") + "\n";
}

export function statusJson(repoId: string, d: StatusData, now: number, store: Store): unknown {
  const byName = (sessionId: string): string | null => {
    const s = store.getSession(sessionId);
    return s ? sessionName(s) : null;
  };
  return {
    repo: repoId,
    sessions: d.sessions.map((s) => ({
      shortId: shortId(s.id),
      name: sessionName(s),
      harness: s.harness,
      source: s.idSource,
      intent: s.intent,
      lastSeenMsAgo: now - s.lastSeen,
      worktree: worktreeLabel(s.worktreeId),
    })),
    completed: d.completed.map((s) => ({
      shortId: shortId(s.id),
      name: sessionName(s),
      harness: s.harness,
      source: s.idSource,
      intent: s.intent,
      endedMsAgo: now - (s.endedAt ?? s.lastSeen),
      worktree: worktreeLabel(s.worktreeId),
    })),
    claims: d.claims.map((c) => ({
      pattern: c.pattern,
      reason: c.reason,
      by: byName(c.sessionId),
      createdMsAgo: now - c.createdAt,
      worktree: worktreeLabel(c.worktreeId),
      scratchpadId: c.scratchpadId ?? null,
    })),
    recentActivity: d.activity.map((a) => ({
      kind: a.kind,
      target: a.target,
      summary: a.summary,
      by: byName(a.sessionId),
      tsMsAgo: now - a.ts,
      worktree: worktreeLabel(a.worktreeId),
      scratchpadId: a.scratchpadId ?? null,
    })),
    notes: d.notes.map((n) => ({ body: n.body, path: n.path, pinned: n.pinned })),
    scratchpads: (d.scratchpads ?? []).map((pad) => ({
      id: pad.id,
      title: pad.title,
      state: pad.state,
      revision: pad.revision,
      updatedMsAgo: now - pad.updatedAt,
      attachedSessions: (d.scratchpadAttachments ?? [])
        .filter((entry) => entry.scratchpadId === pad.id)
        .map((entry) => {
          const session = store.getSession(entry.sessionId);
          return {
            shortId: shortId(entry.sessionId),
            name: session ? sessionName(session) : null,
            worktree: worktreeLabel(entry.worktreeId),
          };
        }),
    })),
  };
}
