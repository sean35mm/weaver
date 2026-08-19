/** OpenCode plugin template and ownership-safe install/remove helpers. */

import fs from "node:fs";
import path from "node:path";
import { homeDirFromEnv } from "./targets.ts";

type Env = Record<string, string | undefined>;

const MARKER = "weaver:opencode-plugin";
export const OPENCODE_PLUGIN_PROTOCOL_VERSION = 4;

export const PLUGIN_SOURCE = `// ${MARKER} protocol=${OPENCODE_PLUGIN_PROTOCOL_VERSION} — managed by \`weaver init --hooks\`.
import { tool } from "@opencode-ai/plugin";

// Structural hooks are best-effort: coordination must never break an OpenCode edit.
const EDIT_TOOLS = new Set(["edit", "write"]);
const MAX_STDOUT_BYTES = 200000;
const MAX_STDERR_BYTES = 16000;
const RUNTIME_KEY = Symbol.for("weaver.opencode.plugin.runtime.v4");
const INVOCATION_KEY = Symbol.for("weaver.opencode.plugin.invocations.v4");
const EDIT_DEDUP_MS = 500;
const DELETE_DEDUP_MS = 30000;
const MAX_DEDUP_ENTRIES = 1000;

function invocationRegistry() {
  return globalThis[INVOCATION_KEY] || (globalThis[INVOCATION_KEY] = { edits: new Map(), deletions: new Map() });
}

function repoKey(base) {
  return String(base.directory || base.worktree || process.cwd()).replace(/[\\/]+$/, "");
}

function sharedInvocation(map, key, ttl, operation) {
  const now = Date.now();
  for (const [candidate, entry] of map) if (entry.expires <= now) map.delete(candidate);
  const existing = map.get(key);
  if (existing && existing.expires > now) return existing.promise;
  if (map.size >= MAX_DEDUP_ENTRIES) map.delete(map.keys().next().value);
  const entry = { expires: Infinity, promise: null };
  const promise = Promise.resolve().then(operation).finally(() => {
    entry.expires = Date.now() + ttl;
  });
  entry.promise = promise;
  map.set(key, entry);
  return promise;
}

async function readBounded(stream, limit) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let kept = 0;
  let truncated = false;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
    if (kept < limit) {
      const take = bytes.subarray(0, limit - kept);
      chunks.push(take);
      kept += take.byteLength;
      if (take.byteLength < bytes.byteLength) truncated = true;
    } else truncated = true;
  }
  const merged = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged) + (truncated ? "\\n… output truncated by Weaver OpenCode integration" : "");
}

async function weaverBestEffort(argv, opts) {
  try {
    const proc = Bun.spawn(["weaver"].concat(argv), {
      cwd: opts.cwd,
      stdin: opts.stdin == null ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "ignore",
      env: opts.env || process.env,
    });
    const out = await readBounded(proc.stdout, MAX_STDOUT_BYTES);
    await proc.exited;
    return out;
  } catch {
    return "";
  }
}

function toolContext(base, context) {
  const cwd = (context && (context.directory || context.worktree)) || base.directory || base.worktree || process.cwd();
  const sessionID = context && context.sessionID;
  const env = sessionID
    ? Object.assign({}, process.env, { OPENCODE_SESSION_ID: sessionID })
    : process.env;
  return { cwd, env, signal: context && context.abort };
}

function commandFailure(code, stdout, stderr) {
  const detail = (stderr || stdout || "no diagnostic output").trim();
  if (/stale scratchpad revision/i.test(detail)) return new Error("Weaver revision conflict: " + detail);
  if (/live attachment|not archived|not active|already in trash|in trash and cannot|cannot be attached/i.test(detail)) {
    return new Error("Weaver lifecycle error: " + detail);
  }
  if (/\\bconflict\\b/i.test(detail)) return new Error("Weaver coordination conflict: " + detail);
  return new Error("Weaver command failed (exit " + code + "): " + detail);
}

// Explicit tools are strict: fixed argv only, stdin for Markdown, bounded output, and visible errors.
async function weaverStrict(argv, base, context, stdin) {
  const opts = toolContext(base, context);
  let proc;
  try {
    proc = Bun.spawn(["weaver"].concat(argv), {
      cwd: opts.cwd,
      stdin: stdin == null ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
      signal: opts.signal,
    });
  } catch (error) {
    throw new Error("Could not start Weaver: " + ((error && error.message) || String(error)));
  }
  const [stdout, stderr, code] = await Promise.all([
    readBounded(proc.stdout, MAX_STDOUT_BYTES),
    readBounded(proc.stderr, MAX_STDERR_BYTES),
    proc.exited,
  ]);
  if (code !== 0) throw commandFailure(code, stdout, stderr);
  return stdout.trim() || JSON.stringify({ ok: true });
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + " must be a positive integer");
  return String(value);
}

function positional(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(label + " cannot be empty");
  if (text.startsWith("-")) throw new Error(label + " cannot start with '-'");
  return text;
}

function revisionArg(value) {
  return "--revision=" + positive(value, "expectedRevision");
}

function tools(base) {
  const id = tool.schema.number().int().positive();
  const revision = tool.schema.number().int().positive();
  const state = tool.schema.enum(["active", "archived", "trash", "all"]);
  return {
    weaver_scratchpad_list: tool({
      description: "List or search Weaver scratchpads. Reuse the active pad for this workstream before creating another.",
      args: {
        query: tool.schema.string().max(1000).optional(),
        state: state.optional(),
        limit: tool.schema.number().int().min(1).max(500).optional(),
      },
      async execute(args, context) {
        const argv = ["scratchpad", args.query ? "find" : "list"];
        if (args.query) argv.push(positional(args.query, "query"));
        argv.push("--state=" + (args.state || "active"), "--limit=" + String(args.limit || 50), "--json");
        return weaverStrict(argv, base, context);
      },
    }),
    weaver_scratchpad_read: tool({
      description: "Read a bounded scratchpad view. Read headings first, then a relevant section before investigating.",
      args: {
        id,
        headings: tool.schema.boolean().optional(),
        section: tool.schema.string().max(500).optional(),
        tail: tool.schema.number().int().min(1).max(500).optional(),
      },
      async execute(args, context) {
        const argv = ["scratchpad", "read", positive(args.id, "id"), "--json"];
        if (args.section) argv.push("--section=" + args.section);
        else if (args.tail) argv.push("--tail=" + String(args.tail));
        else if (args.headings) argv.push("--headings");
        return weaverStrict(argv, base, context);
      },
    }),
    weaver_scratchpad_create: tool({
      description: "Create a Markdown scratchpad for a distinct workstream. Pass the body through stdin, never argv.",
      args: { title: tool.schema.string().min(1).max(200), body: tool.schema.string().max(1000000) },
      async execute(args, context) {
        return weaverStrict(
          ["scratchpad", "create", positional(args.title, "title"), "--from=-", "--json"],
          base,
          context,
          args.body,
        );
      },
    }),
    weaver_scratchpad_use: tool({
      description: "Attach this OpenCode session/worktree to an active scratchpad before repository writes.",
      args: { id },
      async execute(args, context) {
        return weaverStrict(["scratchpad", "use", positive(args.id, "id"), "--json"], base, context);
      },
    }),
    weaver_scratchpad_edit_section: tool({
      description: "Replace only the body under one Markdown heading using optimistic revision control.",
      args: {
        id,
        heading: tool.schema.string().min(1).max(500),
        body: tool.schema.string().max(1000000),
        expectedRevision: revision,
      },
      async execute(args, context) {
        return weaverStrict(
          [
            "scratchpad",
            "edit-section",
            positive(args.id, "id"),
            "--section=" + args.heading,
            "--from=-",
            revisionArg(args.expectedRevision),
            "--json",
          ],
          base,
          context,
          args.body,
        );
      },
    }),
    weaver_scratchpad_rename: tool({
      description: "Rename an active scratchpad at an expected revision.",
      args: { id, title: tool.schema.string().min(1).max(200), expectedRevision: revision },
      async execute(args, context) {
        return weaverStrict(
          [
            "scratchpad",
            "rename",
            positive(args.id, "id"),
            positional(args.title, "title"),
            revisionArg(args.expectedRevision),
            "--json",
          ],
          base,
          context,
        );
      },
    }),
    weaver_scratchpad_archive: tool({
      description: "Archive a completed active scratchpad at an expected revision.",
      args: { id, expectedRevision: revision },
      async execute(args, context) {
        return weaverStrict(
          ["scratchpad", "archive", positive(args.id, "id"), revisionArg(args.expectedRevision), "--json"],
          base,
          context,
        );
      },
    }),
    weaver_scratchpad_restore: tool({
      description: "Restore an archived scratchpad to active at an expected revision.",
      args: { id, expectedRevision: revision },
      async execute(args, context) {
        return weaverStrict(
          ["scratchpad", "restore", positive(args.id, "id"), revisionArg(args.expectedRevision), "--json"],
          base,
          context,
        );
      },
    }),
    weaver_scratchpad_trash: tool({
      description: "Trash only an empty, duplicate, or demonstrably obsolete pad; reason and revision are mandatory.",
      args: {
        id,
        reason: tool.schema.string().min(1).max(2000),
        expectedRevision: revision,
      },
      async execute(args, context) {
        return weaverStrict(
          [
            "scratchpad",
            "trash",
            positive(args.id, "id"),
            "--reason=" + args.reason,
            revisionArg(args.expectedRevision),
            "--json",
          ],
          base,
          context,
        );
      },
    }),
    weaver_scratchpad_recover: tool({
      description: "Recover a scratchpad from trash to its prior active/archived state.",
      args: { id, expectedRevision: revision },
      async execute(args, context) {
        return weaverStrict(
          ["scratchpad", "recover", positive(args.id, "id"), revisionArg(args.expectedRevision), "--json"],
          base,
          context,
        );
      },
    }),
    weaver_facts_list: tool({
      description: "List/search durable Repository Facts. 'notes' remains only a compatibility name.",
      args: {
        query: tool.schema.string().max(1000).optional(),
        path: tool.schema.string().max(2000).optional(),
        topic: tool.schema.string().max(200).optional(),
        includeHistory: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        const argv = ["facts"];
        if (args.query) argv.push(positional(args.query, "query"));
        if (args.path) argv.push("--path=" + args.path);
        if (args.topic) argv.push("--tag=" + args.topic);
        if (args.includeHistory) argv.push("--all");
        argv.push("--json");
        return weaverStrict(argv, base, context);
      },
    }),
    weaver_fact_record: tool({
      description: "Record or supersede a lasting Repository Fact after verifying it is durable repo knowledge.",
      args: {
        text: tool.schema.string().min(1).max(4000),
        path: tool.schema.string().max(2000).optional(),
        topic: tool.schema.string().max(200).optional(),
        pin: tool.schema.boolean().optional(),
        updateId: id.optional(),
      },
      async execute(args, context) {
        const argv = ["fact", positional(args.text, "text")];
        if (args.path) argv.push("--path=" + args.path);
        if (args.topic) argv.push("--tag=" + args.topic);
        if (args.pin) argv.push("--pin");
        if (args.updateId) argv.push("--update=" + positive(args.updateId, "updateId"));
        return weaverStrict(argv, base, context);
      },
    }),
    weaver_fact_forget: tool({
      description: "Retire a wrong or obsolete Repository Fact with an auditable reason.",
      args: { id, reason: tool.schema.string().min(1).max(2000) },
      async execute(args, context) {
        return weaverStrict(
          ["forget", positive(args.id, "id"), positional(args.reason, "reason")],
          base,
          context,
        );
      },
    }),
  };
}

async function createPlugin({ directory, worktree }) {
  const base = { directory, worktree };
  const repo = repoKey(base);
  return {
    tool: tools(base),
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
        tool_input: { file_path: filePath },
      });
      const cwd = directory || worktree || process.cwd();
      const key = [repo, input.sessionID, input.callID || "", input.tool, filePath].join("\u0000");
      const raw = await sharedInvocation(invocationRegistry().edits, key, EDIT_DEDUP_MS, async () => {
        await weaverBestEffort(["hook", "post-edit"], { cwd, stdin: payload });
        return weaverBestEffort(["hook", "pre-edit"], { cwd, stdin: payload });
      });
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
      const key = [repo, event.type, sid].join("\u0000");
      await sharedInvocation(invocationRegistry().deletions, key, DELETE_DEDUP_MS, () =>
        weaverBestEffort(["done"], {
          cwd: directory || worktree || process.cwd(),
          env: Object.assign({}, process.env, { OPENCODE_SESSION_ID: sid }),
        }),
      );
    },
  };
}

export const WeaverPlugin = async (input) => {
  const runtimes = globalThis[RUNTIME_KEY] || (globalThis[RUNTIME_KEY] = new Map());
  const key = input.directory || input.worktree || process.cwd();
  if (!runtimes.has(key)) runtimes.set(key, createPlugin(input));
  return runtimes.get(key);
};
`;

export function opencodePluginPathForRepo(root: string): string {
  return path.join(root, ".opencode", "plugins", "weaver.js");
}

export function opencodePluginPathGlobal(env: Env): string {
  return path.join(homeDirFromEnv(env), ".config", "opencode", "plugins", "weaver.js");
}

export type OpencodePluginInstallResult = "wrote" | "unchanged" | "foreign";
export type OpencodePluginStatus = "current" | "outdated" | "missing" | "foreign";

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
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return "foreign";
  }
  const firstLine = contents.split(/\r?\n/, 1)[0];
  if (firstLine !== `// ${MARKER}` && !firstLine?.startsWith(`// ${MARKER} `)) return "foreign";
  return contents === PLUGIN_SOURCE ? "current" : "outdated";
}

function installAt(file: string): OpencodePluginInstallResult {
  const status = statusAt(file);
  if (status === "foreign") return "foreign";
  if (status === "current") return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLUGIN_SOURCE);
  return "wrote";
}

function uninstallAt(file: string): OpencodePluginInstallResult {
  const status = statusAt(file);
  if (status === "missing") return "unchanged";
  if (status === "foreign") return "foreign";
  fs.rmSync(file);
  return "wrote";
}
