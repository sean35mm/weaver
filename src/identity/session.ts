/**
 * Resolve "which session am I?" — the heart of Weaver.
 * Identity ladder: explicit override → harness-native session id → controlling TTY
 * (self → ancestry). Never returns a shared anonymous key: callers that require identity
 * fail gracefully.
 * The harness *label* resolves separately: env signals first, then known executable names
 * in the process ancestry — harness env vars are not a stable API (OpenCode set
 * OPENCODE_RUN_ID through v1.16.x and removed it in v1.17.0 with no replacement).
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { IdSource } from "../store/store.ts";

export interface Identity {
  key: string;
  source: IdSource;
  label: string;
}

type Env = Record<string, string | undefined>;

/**
 * Per-harness session-id env vars. Order = precedence. These come and go with harness
 * releases: OpenCode ≤1.16.x set OPENCODE_RUN_ID (removed in v1.17.0 with no replacement);
 * OpenCode ≥1.17 never sets OPENCODE_SESSION_ID itself — Weaver's OpenCode plugin
 * (`weaver init --hooks` → .opencode/plugins/weaver.js) injects it via the `shell.env`
 * plugin hook, which resolved sst/opencode#12158.
 */
export const HARNESS_SESSION_ENVS: ReadonlyArray<readonly [label: string, env: string]> = [
  ["claude-code", "CLAUDE_CODE_SESSION_ID"],
  ["opencode", "OPENCODE_SESSION_ID"],
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
  /** Injection seam for tests; defaults to the real `ps`-based ancestry walk. */
  harnessResolver?: (pid: number) => string | null;
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

/** Executable basenames that identify a harness when seen in the process ancestry. */
const HARNESS_PROCESS_NAMES: ReadonlyMap<string, string> = new Map([
  ["claude", "claude-code"],
  ["opencode", "opencode"],
  ["codex", "codex"],
  ["pi", "pi"],
  ["cursor-agent", "cursor"],
]);

/**
 * Walk the process ancestry looking for a known harness executable. Labels harnesses that
 * expose no env signal to subprocesses (e.g. OpenCode ≥1.17). Label only — never identity.
 */
export function detectHarnessFromAncestry(pid: number): string | null {
  const read = (p: number): { ppid: number; comm: string } | null => {
    try {
      const raw = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(p)], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      const m = /^(\d+)\s+(.*)$/.exec(raw);
      return m ? { ppid: Number(m[1]), comm: m[2] ?? "" } : null;
    } catch {
      return null;
    }
  };

  let cur = pid;
  for (let i = 0; i < 8; i++) {
    const row = read(cur);
    if (!row) return null;
    const label = HARNESS_PROCESS_NAMES.get(path.basename(row.comm).toLowerCase());
    if (label) return label;
    if (!row.ppid || row.ppid <= 1) return null;
    cur = row.ppid;
  }
  return null;
}

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
  const pid = opts.pid ?? process.pid;

  // Env signals first; harness executables in the ancestry when the env says nothing.
  const label = (): string => {
    const fromEnv = detectLabel(env);
    if (fromEnv !== "unknown") return fromEnv;
    return (opts.harnessResolver ?? detectHarnessFromAncestry)(pid) ?? "unknown";
  };

  // 1. explicit override
  const explicit = (parseSessionArg(argv) ?? env.WEAVER_SESSION)?.trim();
  if (explicit) return { key: `explicit:${explicit}@${host}`, source: "explicit", label: label() };

  // 2. harness-native session id (most reliable on the tool-call path)
  for (const [harness, key] of HARNESS_SESSION_ENVS) {
    const value = env[key];
    if (value) return { key: `harness:${harness}:${value}@${host}`, source: "harness", label: harness };
  }

  // 3. controlling TTY (self → nearest ancestor)
  const tty = (opts.ttyResolver ?? resolveTtyDevice)(pid);
  if (tty) return { key: `tty:${tty.device}@${host}`, source: tty.viaAncestry ? "ancestry" : "tty", label: label() };

  // 4. none — caller decides (observer reads ok; mutating commands fail with a hint)
  return null;
}
