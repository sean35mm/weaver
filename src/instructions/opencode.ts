/**
 * OpenCode plugin registration: idempotent install/remove of Weaver's identity plugin at a
 * project's `.opencode/plugins/weaver.js`. OpenCode ≥1.17 exposes no session env to shell
 * commands by itself; its `shell.env` plugin hook receives the session id and lets a plugin
 * inject env vars into every shell/PTY command. The file is recognized by MARKER — a
 * `weaver.js` without it is user-owned and is never written over or removed.
 */

import fs from "node:fs";
import path from "node:path";
import { homeDirFromEnv } from "./targets.ts";

type Env = Record<string, string | undefined>;

const MARKER = "weaver:opencode-plugin";

export const PLUGIN_SOURCE = `// ${MARKER} — installed by \`weaver init\`; safe to delete.
// Structural coordination for OpenCode: exports this session's id to shell commands,
// logs edits and refreshes presence, appends conflict advisories to edit-tool output,
// and ends the weaver session when OpenCode deletes its own. Content-free: only the
// opaque session id and edited file paths ever reach weaver. Every call is best-effort —
// weaver being missing or failing can never break OpenCode.
const EDIT_TOOLS = new Set(["edit", "write"]);

async function weaver(argv, opts) {
  try {
    const proc = Bun.spawn(["weaver"].concat(argv), {
      cwd: opts.cwd, // the project directory — a global plugin serves many repos
      stdin: opts.stdin == null ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "ignore",
      env: opts.env || process.env,
    });
    const done = proc.exited;
    const out = await new Response(proc.stdout).text();
    await done;
    return out;
  } catch {
    return "";
  }
}

export const WeaverPlugin = async ({ directory }) => ({
  "shell.env": async (input, output) => {
    if (input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
  },

  "tool.execute.after": async (input, output) => {
    if (!EDIT_TOOLS.has(input.tool)) return;
    const filePath = input.args && input.args.filePath;
    if (typeof filePath !== "string" || !filePath || !input.sessionID) return;
    const payload = JSON.stringify({
      harness: "opencode",
      session_id: input.sessionID,
      cwd: directory,
      tool_input: { file_path: filePath },
    });
    await weaver(["hook", "post-edit"], { cwd: directory, stdin: payload }); // log + refresh presence
    const raw = await weaver(["hook", "pre-edit"], { cwd: directory, stdin: payload }); // conflict picture, rate-limited
    try {
      const advisory = JSON.parse(raw).hookSpecificOutput.additionalContext;
      if (advisory) output.output += "\\n\\n[weaver advisory]\\n" + advisory;
    } catch {
      /* no advisory */
    }
  },

  event: async ({ event }) => {
    if (!event || event.type !== "session.deleted") return;
    const props = event.properties || {};
    const sid = (props.info && props.info.id) || props.sessionID || props.id;
    if (typeof sid !== "string" || !sid) return;
    await weaver(["done"], {
      cwd: directory,
      env: Object.assign({}, process.env, { OPENCODE_SESSION_ID: sid }),
    });
  },
});
`;

export function opencodePluginPathForRepo(root: string): string {
  return path.join(root, ".opencode", "plugins", "weaver.js");
}

/** Global OpenCode plugins load in every repo — this one is repo-agnostic and dependency-free. */
export function opencodePluginPathGlobal(env: Env): string {
  return path.join(homeDirFromEnv(env), ".config", "opencode", "plugins", "weaver.js");
}

export type OpencodePluginInstallResult = "wrote" | "unchanged" | "foreign";
export type OpencodePluginStatus = "installed" | "missing" | "foreign";

export function opencodePluginStatusForRepo(root: string): OpencodePluginStatus {
  return statusAt(opencodePluginPathForRepo(root));
}

export function opencodePluginStatusGlobal(env: Env): OpencodePluginStatus {
  return statusAt(opencodePluginPathGlobal(env));
}

export function installOpencodePlugin(root: string): OpencodePluginInstallResult {
  return installAt(opencodePluginPathForRepo(root));
}

export function installOpencodePluginGlobal(env: Env): OpencodePluginInstallResult {
  return installAt(opencodePluginPathGlobal(env));
}

export function uninstallOpencodePlugin(root: string): OpencodePluginInstallResult {
  return uninstallAt(opencodePluginPathForRepo(root));
}

export function uninstallOpencodePluginGlobal(env: Env): OpencodePluginInstallResult {
  return uninstallAt(opencodePluginPathGlobal(env));
}

function statusAt(file: string): OpencodePluginStatus {
  if (!fs.existsSync(file)) return "missing";
  return fs.readFileSync(file, "utf8").includes(MARKER) ? "installed" : "foreign";
}

/** Write (or refresh) the plugin file; a marker-less existing file is left untouched. */
function installAt(file: string): OpencodePluginInstallResult {
  const status = statusAt(file);
  if (status === "foreign") return "foreign";
  if (status === "installed" && fs.readFileSync(file, "utf8") === PLUGIN_SOURCE) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLUGIN_SOURCE);
  return "wrote";
}

/** Remove the plugin file when it is ours; user-owned files and missing files are no-ops. */
function uninstallAt(file: string): OpencodePluginInstallResult {
  const status = statusAt(file);
  if (status === "missing") return "unchanged";
  if (status === "foreign") return "foreign";
  fs.rmSync(file);
  return "wrote";
}
