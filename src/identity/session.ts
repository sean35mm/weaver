/**
 * Resolve "which session am I?" — the heart of Weaver, validated by the Phase 0 spike.
 * Ladder: explicit override → harness-native session id → controlling TTY (self → ancestry).
 * Never returns a shared anonymous key: callers that require identity fail gracefully.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import type { IdSource } from "../store/store.ts";

export interface Identity {
  key: string;
  source: IdSource;
  label: string;
}

type Env = Record<string, string | undefined>;

/** Per-harness session-id env vars, confirmed in Phase 0. Order = precedence. */
export const HARNESS_SESSION_ENVS: ReadonlyArray<readonly [label: string, env: string]> = [
  ["claude-code", "CLAUDE_CODE_SESSION_ID"],
  ["opencode", "OPENCODE_RUN_ID"],
  ["codex", "CODEX_THREAD_ID"],
];

export interface ResolveOpts {
  env?: Env;
  argv?: string[];
  pid?: number;
  host?: string;
  /** Injection seam for tests; defaults to the real `ps`-based lookup. */
  ttyResolver?: (pid: number) => { device: string; viaAncestry: boolean } | null;
}

function parseSessionArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--session");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--session="));
  return eq ? eq.slice("--session=".length) : undefined;
}

function detectLabel(env: Env): string {
  for (const [label, key] of HARNESS_SESSION_ENVS) if (env[key]) return label;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.OPENCODE) return "opencode";
  if (env.CODEX_SANDBOX) return "codex";
  if (env.PI_CODING_AGENT) return "pi";
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "cursor";
  return "unknown";
}

const isRealTty = (t: string): boolean => !!t && !/^\?+$/.test(t);

/** Controlling terminal of the process, then its nearest ancestor. Returns null if none. */
export function resolveTtyDevice(pid: number): { device: string; viaAncestry: boolean } | null {
  const ps = (p: number, field: string): string => {
    try {
      return execFileSync("ps", ["-o", `${field}=`, "-p", String(p)], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return "";
    }
  };

  const own = ps(pid, "tty");
  if (isRealTty(own)) return { device: own, viaAncestry: false };

  let cur = pid;
  for (let i = 0; i < 8; i++) {
    const ppid = ps(cur, "ppid");
    if (!ppid || ppid === "0" || ppid === "1") break;
    const tty = ps(Number(ppid), "tty");
    if (isRealTty(tty)) return { device: tty, viaAncestry: true };
    cur = Number(ppid);
  }
  return null;
}

export function resolveIdentity(opts: ResolveOpts = {}): Identity | null {
  const env = opts.env ?? (process.env as Env);
  const host = opts.host ?? os.hostname();
  const argv = opts.argv ?? process.argv.slice(2);

  // 1. explicit override
  const explicit = (parseSessionArg(argv) ?? env.WEAVER_SESSION)?.trim();
  if (explicit) return { key: `explicit:${explicit}@${host}`, source: "explicit", label: detectLabel(env) };

  // 2. harness-native session id (most reliable on the tool-call path)
  for (const [label, key] of HARNESS_SESSION_ENVS) {
    const value = env[key];
    if (value) return { key: `harness:${label}:${value}@${host}`, source: "harness", label };
  }

  // 3. controlling TTY (self → nearest ancestor)
  const tty = (opts.ttyResolver ?? resolveTtyDevice)(opts.pid ?? process.pid);
  if (tty)
    return { key: `tty:${tty.device}@${host}`, source: tty.viaAncestry ? "ancestry" : "tty", label: detectLabel(env) };

  // 4. none — caller decides (observer reads ok; mutating commands fail with a hint)
  return null;
}
