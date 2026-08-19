import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-build-"));
const binary = path.join(directory, "weaver");

try {
  const built = spawnSync("bun", ["build", "src/cli.ts", "--compile", `--outfile=${binary}`], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    encoding: "utf8",
  });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(built.stderr || built.stdout || `bun build exited ${built.status}`);

  const smoke = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0 || !/^\d+\.\d+\.\d+/.test(smoke.stdout.trim())) {
    throw new Error(smoke.stderr || `compiled binary returned an invalid version: ${smoke.stdout.trim()}`);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
