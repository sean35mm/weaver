import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveRepoId } from "../../src/repo/identity.ts";
import { acquireStoreMaintenance } from "../../src/store/coordination.ts";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "src/cli.ts");

function runCli(
  repo: string,
  home: string,
  args: string[],
  session = "integration",
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, WEAVER_HOME: home, WEAVER_SESSION: session };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function runConcurrentTasks(repo: string, home: string, prefix: string, count = 8): Promise<void> {
  return Promise.all(
    Array.from(
      { length: count },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const env: NodeJS.ProcessEnv = { ...process.env, WEAVER_HOME: home, WEAVER_SESSION: `${prefix}-${index}` };
          delete env.CLAUDE_CODE_SESSION_ID;
          delete env.CODEX_THREAD_ID;
          delete env.OPENCODE_SESSION_ID;
          delete env.OPENCODE_RUN_ID;
          const child = spawn(process.execPath, [cliPath, "task", `${prefix} task ${index}`], {
            cwd: repo,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0 && /✓ task:/.test(stdout)) resolve();
            else reject(new Error(`concurrent task ${index} exited ${code}: ${stderr || stdout}`));
          });
        }),
    ),
  ).then(() => undefined);
}

test("fresh and existing stores accept concurrent fresh-process CLI writes", { timeout: 30_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-concurrent-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-concurrent-home-"));
  fs.writeFileSync(path.join(repo, "README.md"), "isolated test repo\n");

  await runConcurrentTasks(repo, home, "fresh");
  await runConcurrentTasks(repo, home, "existing");
});

test("CLI is blocked by maintenance before store creation", { timeout: 30_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-fenced-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-fenced-home-"));
  fs.writeFileSync(path.join(repo, "README.md"), "isolated test repo\n");
  const repoId = resolveRepoId(repo).repoId;
  const fence = await acquireStoreMaintenance({ repoId, weaverHome: home, reason: "purge" });
  assert.equal(fence.acquired, true);
  try {
    const result = await runCli(repo, home, ["task", "blocked"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /maintenance/);
    assert.equal(fs.existsSync(path.join(home, `${repoId}.db`)), false);
  } finally {
    if (fence.acquired) await fence.release();
  }
});
