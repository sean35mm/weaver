#!/usr/bin/env node
/*
 * Weaver — Phase 0 identity spike  (THROWAWAY diagnostic; delete after Phase 0)
 * ---------------------------------------------------------------------------
 * Goal: confirm Weaver can derive a session key that is STABLE per session/window and
 * DISTINCT across windows AND across different sessions of the SAME harness — BEFORE
 * building the data model on it.
 *
 * First-run finding (Claude Code tool call): the immediate process often has NO
 * controlling TTY (stdio is piped + no controlling terminal), but harnesses expose a
 * stable per-session UUID via env (e.g. CLAUDE_CODE_SESSION_ID), and the TTY is still
 * recoverable by walking the process ancestry. So the resolution ladder is:
 *
 *   1. explicit         — --session <id> / WEAVER_SESSION   (tests, headless, escape hatch)
 *   2. harness session  — a stable per-session env var       (BEST for tool-call contexts)
 *   3. tty (self|ancestry) — controlling terminal, self or nearest ancestor
 *   4. none             — graceful fail (no anonymous key); observer reads still work
 *
 * Runs under both runtimes (no install):
 *     node scripts/spike-identity.mjs      |      bun scripts/spike-identity.mjs
 * Explicit-id paths:
 *     WEAVER_SESSION=abc node scripts/spike-identity.mjs   |   node scripts/spike-identity.mjs --session abc
 */

import { execSync } from 'node:child_process';
import os from 'node:os';

const host = os.hostname();
const sh = (cmd) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
};
const isReal = (t) => !!t && !/^\?+$/.test(t);

// --- 1. explicit override ---------------------------------------------------
const argv = process.argv.slice(2);
const sIdx = argv.indexOf('--session');
const explicitId = ((sIdx >= 0 ? argv[sIdx + 1] : undefined) || process.env.WEAVER_SESSION || '').trim();

// --- 2. harness-native session id (extend this list as we learn each harness) ---
const HARNESS_SESSION_ENVS = [
  ['claude-code', 'CLAUDE_CODE_SESSION_ID'], // confirmed
  ['opencode', 'OPENCODE_RUN_ID'],           // confirmed
  ['codex', 'CODEX_THREAD_ID'],              // confirmed — seatbelt sandbox kills tty/ancestry, so env id is the ONLY signal
  // pi: no per-session env var found (only PI_CODING_AGENT marker) → resolves via tty/ancestry or explicit --session
];
let harnessSession = null;
for (const [label, envk] of HARNESS_SESSION_ENVS) {
  if (process.env[envk]) { harnessSession = { label, envk, id: process.env[envk] }; break; }
}

// --- 3. controlling tty: self, else nearest ancestor with a real tty --------
const selfPid = process.pid;
const selfTty = sh(`ps -o tty= -p ${selfPid}`);
const psField = (pid, f) => sh(`ps -o ${f}= -p ${pid}`);
function ancestry(start, depth = 8) {
  const rows = [];
  let pid = String(start);
  for (let i = 0; i < depth && pid && pid !== '0' && pid !== '1'; i++) {
    const ppid = psField(pid, 'ppid');
    rows.push({ pid, ppid, comm: psField(pid, 'comm'), tty: psField(pid, 'tty') });
    if (!ppid) break;
    pid = ppid;
  }
  return rows;
}
const ancestryRows = ancestry(selfPid);
const ancestryTtyRow = ancestryRows.find((r) => isReal(r.tty));
const ttyDevice = isReal(selfTty) ? selfTty : (ancestryTtyRow ? ancestryTtyRow.tty : '');

// --- 4. harness label + raw env scan ---------------------------------------
function detectHarness() {
  const e = process.env;
  if (harnessSession) return harnessSession.label;
  if (e.CLAUDECODE || e.CLAUDE_CODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (e.CODEX_SANDBOX || e.CODEX_HOME || e.OPENAI_CODEX) return 'codex';
  if (e.OPENCODE || e.OPENCODE_BIN || e.OPENCODE_CONFIG) return 'opencode';
  if (e.PI_HOME || e.PI_SESSION || e.PI_CONFIG) return 'pi';
  if (e.CURSOR_TRACE_ID || e.CURSOR_AGENT) return 'cursor';
  return 'unknown';
}
const envHints = Object.entries(process.env)
  .filter(([k]) => /CLAUDE|CODEX|OPENCODE|CURSOR|AIDER|GEMINI|^PI_|^PI$|AGENT|ANTHROPIC|OPENAI|CMUX|SESSION/i.test(k))
  .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
  .sort();

// --- 5. resolve: explicit → harness session → tty(self|ancestry) → none -----
let key, source;
if (explicitId) {
  key = `explicit:${explicitId}@${host}`; source = 'explicit';
} else if (harnessSession) {
  key = `harness:${harnessSession.label}:${harnessSession.id}@${host}`; source = `harness (${harnessSession.envk})`;
} else if (ttyDevice) {
  key = `tty:${ttyDevice}@${host}`; source = isReal(selfTty) ? 'tty (self)' : 'tty (ancestry)';
} else {
  key = null; source = 'none';
}

// --- 6. report --------------------------------------------------------------
const line = (l = '') => process.stdout.write(l + '\n');
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;

line('──────────────────────────────────────────────────────────');
line('  Weaver identity spike');
line('──────────────────────────────────────────────────────────');
line(`  runtime          : ${runtime}`);
line(`  host             : ${host}`);
line(`  pid / ppid       : ${selfPid} / ${process.ppid}`);
line(`  controlling tty  : self=${selfTty || '(none)'}  ancestry=${ancestryTtyRow ? ancestryTtyRow.tty : '(none)'}  → ${ttyDevice || '(none)'}`);
line(`  stdio isTTY      : in=${!!process.stdin.isTTY} out=${!!process.stdout.isTTY} err=${!!process.stderr.isTTY}`);
line(`  harness (guess)  : ${detectHarness()}`);
line(`  harness session  : ${harnessSession ? `${harnessSession.envk}=${harnessSession.id}` : '(none found)'}`);
line(`  explicit id      : ${explicitId || '(none)'}`);
line('');
line(`  >>> RESOLVED KEY : ${key ?? '(NONE — mutating cmds would fail with a WEAVER_SESSION hint)'}`);
line(`  >>> SOURCE       : ${source}`);
line('');
line('  terminal env signals:');
for (const k of ['TERM_SESSION_ID', 'TMUX', 'TMUX_PANE', 'WINDOWID', 'STY', 'SSH_TTY', 'TERM', 'TERM_PROGRAM']) {
  line(`    ${k.padEnd(16)} = ${process.env[k] ?? '(unset)'}`);
}
line('');
line('  harness/agent/session env hints (look here for each harness\'s session id):');
if (envHints.length) for (const h of envHints) line(`    ${h}`);
else line('    (none found)');
line('');
line('  process ancestry (pid → ppid, comm, tty):');
for (const r of ancestryRows) {
  line(`    ${String(r.pid).padEnd(8)} ppid=${String(r.ppid).padEnd(8)} tty=${(r.tty || '-').padEnd(10)} ${r.comm}`);
}
line('──────────────────────────────────────────────────────────');
