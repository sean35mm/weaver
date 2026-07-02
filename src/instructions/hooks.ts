/**
 * Claude Code hook registration: idempotent merge/remove of Weaver's hook entries in a
 * project's `.claude/settings.json`. Entries are recognized by their command containing
 * `weaver hook` (the marker), so user-defined hooks and unknown keys are always preserved.
 */

import fs from "node:fs";
import path from "node:path";
import { homeDirFromEnv } from "./targets.ts";

type Env = Record<string, string | undefined>;

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

/** Global Claude Code settings — hooks here fire in every repo (the marker command no-ops where weaver isn't set up). */
export function globalSettingsPath(env: Env): string {
  return path.join(homeDirFromEnv(env), ".claude", "settings.json");
}

const isWeaverEntry = (h: HookEntry): boolean => typeof h?.command === "string" && h.command.includes(MARKER);

/**
 * Strip Weaver's hook entries from one event list, leaving everything else untouched. Only
 * marker-matching entries are removed — a group that also carries user-defined hooks keeps
 * them (and the group); a group left empty is dropped.
 */
function withoutWeaver(groups: MatcherGroup[]): MatcherGroup[] {
  const out: MatcherGroup[] = [];
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter((h) => !isWeaverEntry(h));
    if (kept.length === group.hooks.length) out.push(group);
    else if (kept.length > 0) out.push({ ...group, hooks: kept });
  }
  return out;
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
export type HookStatus = "installed" | "partial" | "missing" | "invalid-json";

function hasWeaverCommand(settings: Settings, event: string, weaverEvent: "pre-edit" | "post-edit"): boolean {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((group) =>
    group.hooks?.some((hook) => isWeaverEntry(hook) && hook.command.includes(`weaver hook ${weaverEvent}`)),
  );
}

function hasAnyWeaverCommand(settings: Settings): boolean {
  return Object.values(settings.hooks ?? {}).some(
    (groups) => Array.isArray(groups) && groups.some((group) => group.hooks?.some(isWeaverEntry)),
  );
}

export function hookStatusForRepo(root: string): HookStatus {
  return hookStatusForFile(settingsPathForRepo(root));
}

export function hookStatusGlobal(env: Env): HookStatus {
  return hookStatusForFile(globalSettingsPath(env));
}

function hookStatusForFile(file: string): HookStatus {
  if (!fs.existsSync(file)) return "missing";
  let settings: Settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  } catch {
    return "invalid-json";
  }
  const pre = hasWeaverCommand(settings, "PreToolUse", "pre-edit");
  const post = hasWeaverCommand(settings, "PostToolUse", "post-edit");
  if (pre && post) return "installed";
  return pre || post || hasAnyWeaverCommand(settings) ? "partial" : "missing";
}

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
  return uninstallAt(settingsPathForRepo(root));
}

export function installHooksGlobal(env: Env): HookInstallResult {
  return rewrite(globalSettingsPath(env), injectHooks);
}

export function uninstallHooksGlobal(env: Env): HookInstallResult {
  return uninstallAt(globalSettingsPath(env));
}

function uninstallAt(file: string): HookInstallResult {
  if (!fs.existsSync(file)) return "unchanged";
  return rewrite(file, removeHooks);
}
