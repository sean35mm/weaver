/**
 * Claude Code hook registration: idempotent merge/remove of Weaver's hook entries in a
 * project's `.claude/settings.json`. Entries are recognized by their command containing
 * `weaver hook` (the marker), so user-defined hooks and unknown keys are always preserved.
 */

import fs from "node:fs";
import path from "node:path";

/** Tool matcher covering every file-mutating Claude Code tool. */
const MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const MARKER = "weaver hook";
/** `command -v` guard keeps committed settings harmless for collaborators without weaver. */
const command = (event: "pre-edit" | "post-edit"): string =>
  `command -v weaver >/dev/null 2>&1 && weaver hook ${event} || true`;

const EVENTS: ReadonlyArray<readonly ["PreToolUse" | "PostToolUse", "pre-edit" | "post-edit"]> = [
  ["PreToolUse", "pre-edit"],
  ["PostToolUse", "post-edit"],
];

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}
interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

export function settingsPathForRepo(root: string): string {
  return path.join(root, ".claude", "settings.json");
}

const isWeaverGroup = (group: MatcherGroup): boolean =>
  Array.isArray(group.hooks) && group.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER));

/** Drop our matcher groups from one event list, leaving everything else untouched. */
function withoutWeaver(groups: MatcherGroup[]): MatcherGroup[] {
  return groups.filter((g) => !isWeaverGroup(g));
}

export function injectHooks(settings: Settings): Settings {
  const hooks: Record<string, MatcherGroup[]> = { ...(settings.hooks ?? {}) };
  for (const [event, weaverEvent] of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...withoutWeaver(existing),
      { matcher: MATCHER, hooks: [{ type: "command", command: command(weaverEvent), timeout: 10 }] },
    ];
  }
  return { ...settings, hooks };
}

export function removeHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = Array.isArray(groups) ? withoutWeaver(groups) : groups;
    if (Array.isArray(kept) && kept.length === 0) continue; // drop empty event lists
    hooks[event] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

export type HookInstallResult = "wrote" | "unchanged" | "invalid-json";

function rewrite(file: string, transform: (s: Settings) => Settings): HookInstallResult {
  let settings: Settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
    } catch {
      return "invalid-json"; // never clobber a file we can't faithfully rewrite
    }
  }
  const next = transform(settings);
  const out = `${JSON.stringify(next, null, 2)}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (out === existing) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return "wrote";
}

export function installHooks(root: string): HookInstallResult {
  return rewrite(settingsPathForRepo(root), injectHooks);
}

export function uninstallHooks(root: string): HookInstallResult {
  const file = settingsPathForRepo(root);
  if (!fs.existsSync(file)) return "unchanged";
  return rewrite(file, removeHooks);
}
