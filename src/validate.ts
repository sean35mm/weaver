/**
 * CLI-boundary validation. Lenient + warn: friendly errors (never stack traces), coerce
 * questionable-but-harmless input, cap sizes. No schema library — see IMPLEMENTATION_PLAN.
 */

import type { Identity } from "./identity/session.ts";
import { ACTIVITY_KINDS, type ActivityKind } from "./store/store.ts";

/** Thrown for user-facing input problems; the dispatcher prints `.message` and exits `.code`. */
export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function requireArg(value: string | undefined, name: string): string {
  const v = value?.trim();
  if (!v) throw new CliError(`missing required <${name}>`);
  return v;
}

/** Agent/mutating commands need a resolved session; fail with a friendly hint otherwise. */
export function requireIdentity(identity: Identity | null): Identity {
  if (!identity) {
    throw new CliError("no session identity — set WEAVER_SESSION=<id> or run inside a supported agent");
  }
  return identity;
}

const MAX_TEXT = 4000;

/** Trim and cap free text so a runaway agent can't bloat the store. */
export function clamp(text: string, max = MAX_TEXT): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Unknown kinds are coerced to `run` with a warning (lenient), never rejected. */
export function normalizeKind(raw: string | undefined): { kind: ActivityKind; warning?: string } {
  const k = (raw ?? "").trim().toLowerCase();
  if ((ACTIVITY_KINDS as readonly string[]).includes(k)) return { kind: k as ActivityKind };
  return { kind: "run", warning: `unknown activity kind ${JSON.stringify(raw)} — recorded as "run"` };
}

const TTL_RE = /^(\d+)\s*([smhd])?$/i;
const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30m" / "2h" / "90s" → bounded ms. Falls back on garbage (lenient). */
export function parseTtl(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const m = TTL_RE.exec(raw.trim());
  if (!m) return fallbackMs;
  const ms = Number(m[1]) * (UNIT_MS[(m[2] ?? "m").toLowerCase()] ?? 60_000);
  return Math.min(Math.max(ms, TTL_MIN_MS), TTL_MAX_MS);
}

/** A claim covering essentially the whole repo — allowed, but worth flagging. */
export function isBroadGlob(pattern: string): boolean {
  const p = pattern.trim();
  return p === "" || p === "**" || p === "/" || p === "*" || p === "." || p === "./**";
}
