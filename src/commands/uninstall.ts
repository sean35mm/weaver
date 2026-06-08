import fs from "node:fs";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { isStandaloneBinary } from "../env.ts";
import { weaverDir } from "../store/location.ts";

function countRepos(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".db")).length;
  } catch {
    return 0;
  }
}

function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      const answer = chunk.toString().trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

export async function run(ctx: Ctx): Promise<number> {
  if (!isStandaloneBinary()) {
    ctx.err("weaver: `uninstall` only applies to the standalone (curl-installed) binary.\n");
    ctx.err("  You're running from source or an npm link — remove that manually (e.g. `npm rm -g`),\n");
    ctx.err("  and `rm -rf ~/.weaver` if you also want to clear the data.\n");
    return 1;
  }

  const keepData = flagBool(ctx.args, "keep-data");
  const dir = weaverDir();
  const repos = countRepos(dir);

  if (!flagBool(ctx.args, "yes")) {
    if (!process.stdin.isTTY) {
      ctx.err("weaver: refusing to uninstall without confirmation — re-run with --yes.\n");
      return 1;
    }
    const what = keepData
      ? "the weaver binary"
      : `the weaver binary and ~/.weaver (${repos} repo${repos === 1 ? "" : "s"})`;
    if (!(await confirm(`Remove ${what}? [y/N] `))) {
      ctx.out("aborted\n");
      return 0;
    }
  }

  if (!keepData) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      ctx.out(`✓ removed ${dir}\n`);
    } catch (e) {
      ctx.err(`weaver: couldn't remove ${dir}: ${(e as Error).message}\n`);
    }
  }

  const bin = process.execPath;
  try {
    fs.rmSync(bin, { force: true });
    ctx.out(`✓ removed ${bin}\n`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const hint = code === "EACCES" || code === "EPERM" ? ` (try: sudo rm ${bin})` : "";
    ctx.err(`weaver: couldn't remove the binary${hint}: ${(e as Error).message}\n`);
    return 1;
  }

  ctx.out("\nweaver uninstalled. Any `weaver` blocks left in project or global instruction files are\n");
  ctx.out("self-disabling; run `weaver deinit` or `weaver deinit --global` beforehand if you want them gone.\n");
  return 0;
}
