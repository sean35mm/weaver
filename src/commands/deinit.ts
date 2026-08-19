import fs from "node:fs";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { quiesceDashboard } from "../dashboard/maintenance.ts";
import { removeBlock } from "../instructions/block.ts";
import { uninstallHooks, uninstallHooksGlobal } from "../instructions/hooks.ts";
import { uninstallOpencodePlugin, uninstallOpencodePluginGlobal } from "../instructions/opencode.ts";
import { instructionTargets, scopeFromFlags } from "../instructions/targets.ts";
import { acquireStoreMaintenance, drainStoreHolders } from "../store/coordination.ts";

export function purgeStoreFiles(
  dbPath: string,
  remove: (file: string, opts: { force: true }) => void = fs.rmSync,
): string[] {
  const failures: string[] = [];
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    try {
      remove(file, { force: true });
    } catch (error) {
      failures.push(`${file}: ${(error as Error).message}`);
    }
  }
  return failures;
}

export async function run(ctx: Ctx): Promise<number> {
  const flagged = scopeFromFlags(ctx);
  if (flagged === "conflict") {
    ctx.err("weaver: choose either --project or --global, not both.\n");
    return 1;
  }
  const scope = flagged ?? "project";
  const cleaned: string[] = [];
  for (const target of instructionTargets(ctx, scope)) {
    if (!fs.existsSync(target.file)) continue;
    const existing = fs.readFileSync(target.file, "utf8");
    const next = removeBlock(existing);
    if (next !== existing) {
      fs.writeFileSync(target.file, next);
      cleaned.push(target.label);
    }
  }
  ctx.out(`✓ removed Weaver instructions${cleaned.length ? ` from ${cleaned.join(", ")}` : " (none found)"}\n`);

  // Harness integrations are removed for the scope being deinited.
  if (scope === "project") {
    if (uninstallHooks(ctx.repo.root) === "wrote") {
      ctx.out("✓ removed Claude Code hooks from .claude/settings.json\n");
    }
    if (uninstallOpencodePlugin(ctx.repo.root) === "wrote") {
      ctx.out("✓ removed OpenCode plugin at .opencode/plugins/weaver.js\n");
    }
  } else {
    if (uninstallHooksGlobal(ctx.env) === "wrote") {
      ctx.out("✓ removed Claude Code hooks from ~/.claude/settings.json\n");
    }
    if (uninstallOpencodePluginGlobal(ctx.env) === "wrote") {
      ctx.out("✓ removed OpenCode plugin at ~/.config/opencode/plugins/weaver.js\n");
    }
  }

  if (flagBool(ctx.args, "purge")) {
    const holder = ctx.storeHolder;
    const dbPath = ctx.storePath;
    if (!holder || !dbPath || !ctx.storeHome) {
      ctx.err("weaver: store purge requires an active store holder\n");
      return 1;
    }
    const runtime = holder.runtime;
    ctx.out(
      "! --purge deletes this repo's authored scratchpads, revision history, Repository Facts, sessions, claims, and activity.\n",
    );
    const maintenance = await acquireStoreMaintenance({
      repoId: ctx.repo.repoId,
      weaverHome: ctx.storeHome,
      reason: "purge",
    });
    if (!maintenance.acquired) {
      ctx.err("weaver: store purge blocked by active or unsafe maintenance\n");
      return 1;
    }
    try {
      const quiescence = await quiesceDashboard({
        store: ctx.store,
        repoId: ctx.repo.repoId,
        scopeId: runtime.storeScopeId,
        runtimeDirectory: runtime.storeDirectory,
      });
      if (!quiescence.ok) {
        ctx.err(`weaver: store purge blocked: ${quiescence.error}\n`);
        return 1;
      }
      ctx.store.close();
      try {
        await holder.release();
      } catch (error) {
        ctx.err(`weaver: store purge could not release its holder: ${(error as Error).message}\n`);
        return 1;
      }
      const drained = await drainStoreHolders(maintenance, runtime);
      if (!drained.ok) {
        ctx.err(`weaver: store purge blocked: ${drained.error}\n`);
        return 1;
      }
      if (!(await maintenance.revalidate())) {
        ctx.err("weaver: store purge blocked: maintenance fence ownership changed\n");
        return 1;
      }
      const failures = purgeStoreFiles(dbPath);
      if (failures.length) {
        for (const failure of failures) ctx.err(`weaver: couldn't remove ${failure}\n`);
        ctx.err("weaver: store purge incomplete\n");
        return 1;
      }
      ctx.out(`✓ purged store at ${dbPath}\n`);
    } finally {
      await maintenance.release().catch(() => undefined);
    }
  }
  return 0;
}
