import os from "node:os";
import path from "node:path";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";

export type InstructionScope = "project" | "global";

export interface InstructionTarget {
  file: string;
  label: string;
}

const PROJECT_TARGET_FILES = ["CLAUDE.md", "AGENTS.md"];

function envPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function homeDir(ctx: Ctx): string {
  const home = envPath(ctx.env.HOME) ?? envPath(os.homedir());
  if (!home) throw new Error("couldn't resolve home directory for global instructions");
  return home;
}

export function scopeFromFlags(ctx: Ctx): InstructionScope | null | "conflict" {
  const project = flagBool(ctx.args, "project");
  const globalScope = flagBool(ctx.args, "global");
  if (project && globalScope) return "conflict";
  if (globalScope) return "global";
  if (project) return "project";
  return null;
}

export function instructionTargets(ctx: Ctx, scope: InstructionScope): InstructionTarget[] {
  if (scope === "project") {
    return PROJECT_TARGET_FILES.map((name) => ({
      file: path.join(ctx.repo.root, name),
      label: name,
    }));
  }

  const home = homeDir(ctx);
  const codexHomeFromEnv = envPath(ctx.env.CODEX_HOME);
  const codexHome = codexHomeFromEnv ?? path.join(home, ".codex");
  return [
    { file: path.join(home, ".claude", "CLAUDE.md"), label: "~/.claude/CLAUDE.md" },
    {
      file: path.join(home, ".config", "opencode", "AGENTS.md"),
      label: "~/.config/opencode/AGENTS.md",
    },
    {
      file: path.join(codexHome, "AGENTS.md"),
      label: codexHomeFromEnv ? "$CODEX_HOME/AGENTS.md" : "~/.codex/AGENTS.md",
    },
  ];
}
