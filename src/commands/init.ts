import fs from "node:fs";
import path from "node:path";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { injectBlock } from "../instructions/block.ts";
import { installHooks, settingsPathForRepo } from "../instructions/hooks.ts";
import { type InstructionScope, instructionTargets, scopeFromFlags } from "../instructions/targets.ts";
import { storePathForRepo } from "../store/location.ts";

function readAnswer(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      resolve(chunk.toString().trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

async function promptScope(ctx: Ctx): Promise<InstructionScope> {
  ctx.out("Where should Weaver install agent instructions?\n\n");
  ctx.out("1. Project files: ./CLAUDE.md, ./AGENTS.md — this repo only\n");
  ctx.out(
    "2. Global files: ~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md, ~/.codex/AGENTS.md — every repo, one-time setup\n\n",
  );

  for (;;) {
    ctx.out("Selection [1]: ");
    const answer = await readAnswer();
    if (answer === "" || answer === "1" || answer === "p" || answer === "project") return "project";
    if (answer === "2" || answer === "g" || answer === "global") return "global";
    ctx.err("weaver: enter 1 for project or 2 for global.\n");
  }
}

async function chooseScope(ctx: Ctx): Promise<InstructionScope | null> {
  const flagged = scopeFromFlags(ctx);
  if (flagged === "conflict") {
    ctx.err("weaver: choose either --project or --global, not both.\n");
    return null;
  }
  if (flagged) return flagged;
  if (process.stdin.isTTY && process.stdout.isTTY) return promptScope(ctx);
  return "project";
}

/**
 * Claude Code hooks are always project-scoped (.claude/settings.json in this repo).
 * Interactive runs prompt (default yes); non-interactive runs install only on explicit
 * --hooks, so scripted inits never write settings the user didn't ask for.
 */
async function chooseHooks(ctx: Ctx): Promise<boolean> {
  if (flagBool(ctx.args, "hooks") && flagBool(ctx.args, "no-hooks")) {
    ctx.err("weaver: choose either --hooks or --no-hooks, not both.\n");
    return false;
  }
  if (flagBool(ctx.args, "hooks")) return true;
  if (flagBool(ctx.args, "no-hooks")) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  ctx.out("\nInstall Claude Code hooks for this repo? They warn agents before they edit an area\n");
  ctx.out("another agent is working in, and keep busy agents visibly live. [Y/n]: ");
  const answer = await readAnswer();
  return answer === "" || answer === "y" || answer === "yes";
}

export async function run(ctx: Ctx): Promise<number> {
  const scope = await chooseScope(ctx);
  if (!scope) return 1;

  ctx.store.setMeta("enabled", "1");
  ctx.store.setMeta("repo_id", ctx.repo.repoId);

  const wrote: string[] = [];
  const unchanged: string[] = [];
  for (const target of instructionTargets(ctx, scope)) {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
    const next = injectBlock(existing);
    if (next !== existing) {
      fs.writeFileSync(target.file, next);
      wrote.push(target.label);
    } else {
      unchanged.push(target.label);
    }
  }

  let hooksLine: string | null = null;
  if (await chooseHooks(ctx)) {
    const result = installHooks(ctx.repo.root);
    const file = settingsPathForRepo(ctx.repo.root);
    if (result === "invalid-json") {
      ctx.err(
        `weaver: ${file} isn't valid JSON — skipped installing hooks; fix it and re-run \`weaver init --hooks\`.\n`,
      );
    } else {
      hooksLine =
        result === "wrote" ? ".claude/settings.json (Claude Code hooks)" : ".claude/settings.json (already current)";
    }
  }

  ctx.out(scope === "global" ? "✓ weaver initialized (global)\n" : "✓ weaver initialized for this repo\n");
  ctx.out(`  repo  : ${ctx.repo.repoId} (${ctx.repo.basis})\n`);
  ctx.out(`  store : ${storePathForRepo(ctx.repo.repoId)}\n`);
  ctx.out(`  scope : ${scope}\n`);
  if (wrote.length) ctx.out(`  wrote : ${wrote.join(", ")}\n`);
  if (unchanged.length) ctx.out(`  ok    : ${unchanged.join(", ")} (already current)\n`);
  if (hooksLine) ctx.out(`  hooks : ${hooksLine}\n`);
  if (scope === "global") {
    ctx.out("\nGlobal instructions cover every repo on this machine — no per-repo init needed.\n");
    ctx.out("Each repo's store is created automatically the first time an agent uses weaver there.\n");
  } else {
    ctx.out("\nProject instructions cover this checkout only. Run `weaver init` in other repos,\n");
    ctx.out("or `weaver init --global` once to cover every repo on this machine.\n");
  }
  return 0;
}
