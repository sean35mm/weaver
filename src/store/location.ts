/** Where the per-repo store lives on disk. Global, keyed by repo identity. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root for all Weaver stores. `WEAVER_HOME` overrides (useful for tests). */
export function weaverDir(): string {
  return process.env.WEAVER_HOME ?? path.join(os.homedir(), ".weaver");
}

export function storePathForRepo(repoId: string): string {
  return path.join(weaverDir(), `${repoId}.db`);
}

export function ensureWeaverDir(): string {
  const dir = weaverDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
