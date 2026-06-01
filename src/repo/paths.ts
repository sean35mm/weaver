/**
 * Normalize user-supplied paths/globs to repo-root-relative POSIX form before they are stored
 * or matched. One seam so conflict detection always compares apples to apples, regardless of
 * the cwd a command was run from or the OS separators used.
 */

import path from "node:path";

const GLOB_CHARS = /[*?{}[\]!()]/;

const toPosix = (p: string): string => p.replace(/\\/g, "/");
const stripDotSlash = (p: string): string => p.replace(/^(\.\/)+/, "");
const squeeze = (p: string): string => p.replace(/\/{2,}/g, "/").replace(/\/$/, "");

/** cwd expressed relative to the repo root (empty when cwd is the root or outside it). */
export function repoRelPrefix(root: string, cwd: string): string {
  const rel = toPosix(path.relative(root, cwd));
  return rel && rel !== "." && !rel.startsWith("..") ? rel : "";
}

export function isGlob(target: string): boolean {
  return GLOB_CHARS.test(target);
}

export function normalizeTarget(target: string, root: string, cwd: string): string {
  const raw = target.trim();

  // Absolute (POSIX or Windows-drive) → relativize to root directly.
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return squeeze(toPosix(path.relative(root, raw)));
  }

  const rel = stripDotSlash(toPosix(raw));
  const prefix = repoRelPrefix(root, cwd);
  const joined = prefix ? `${prefix}/${rel}` : rel;

  // POSIX-normalize collapses `.`/`..` and is safe for globs: it only rewrites `.`/`..`
  // segments and slashes, leaving `*`, `**`, `{…}`, `[…]` tokens intact. This ensures e.g.
  // `../api/**` from `src/auth` stores `src/api/**`, not `src/auth/../api/**`.
  return squeeze(path.posix.normalize(joined));
}
