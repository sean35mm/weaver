/**
 * Resolve a stable identity for the current repo so every window/worktree of the same logical
 * repo shares one store. Basis preference: normalized git remote → root-commit hash → path.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RepoBasis = "remote" | "root-commit" | "path";

export interface RepoIdentity {
  repoId: string;
  root: string;
  basis: RepoBasis;
  /** Opaque identifier for this physical checkout; never a path. */
  worktreeId?: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Canonicalize a remote URL so ssh and https forms of the same repo collapse together. */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme: https:// ssh:// git://
  u = u.replace(/^[^@/]+@/, ""); // strip user@  (e.g. git@github.com)
  u = u.replace(":", "/"); // scp-style host:owner → host/owner (first colon only)
  u = u.replace(/\.git$/i, "");
  u = u.replace(/\/+$/, "");
  return u.toLowerCase();
}

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveRepoId(cwd: string = process.cwd()): RepoIdentity {
  const discoveredRoot = git(["rev-parse", "--show-toplevel"], cwd) ?? path.resolve(cwd);
  const root = (() => {
    try {
      return fs.realpathSync.native(discoveredRoot);
    } catch {
      return path.resolve(discoveredRoot);
    }
  })();
  const worktreeId = shortHash("worktree:" + root);

  const remote = git(["remote", "get-url", "origin"], root);
  if (remote) {
    return { repoId: shortHash("remote:" + normalizeRemoteUrl(remote)), root, basis: "remote", worktreeId };
  }

  const rootCommit = git(["rev-list", "--max-parents=0", "HEAD"], root);
  if (rootCommit) {
    const first = rootCommit.split("\n")[0]!;
    return { repoId: shortHash("commit:" + first), root, basis: "root-commit", worktreeId };
  }

  return { repoId: shortHash("path:" + path.resolve(root)), root, basis: "path", worktreeId };
}
