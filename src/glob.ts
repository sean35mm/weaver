/**
 * Glob matching for claims/conflicts. `matchesPath` is precise (picomatch). `globsOverlap` is
 * a deliberately conservative heuristic — because claims are advisory, a false "possible
 * overlap" is far cheaper than missing a real one, so we bias toward overlap.
 */

import picomatch from "picomatch";
import { isGlob } from "./repo/paths.ts";

const matchers = new Map<string, (p: string) => boolean>();

function matcher(glob: string): (p: string) => boolean {
  let m = matchers.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matchers.set(glob, m);
  }
  return m;
}

export function matchesPath(glob: string, path: string): boolean {
  return matcher(glob)(path);
}

const GLOB_SEG = /[*?{}[\]!()]/;

function literalPrefix(glob: string): string {
  const out: string[] = [];
  for (const seg of glob.split("/")) {
    if (GLOB_SEG.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

function isPathPrefix(prefix: string, full: string): boolean {
  if (prefix === "") return true;
  return full === prefix || full.startsWith(`${prefix}/`);
}

/** Heuristic overlap between two globs via literal-prefix containment (biased to true). */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  if (pa === "" || pb === "") return true; // a very broad glob overlaps anything
  return isPathPrefix(pa, pb) || isPathPrefix(pb, pa);
}

/** Overlap between a checked `target` and a stored `candidate`; either may be a path or glob. */
export function targetsOverlap(target: string, candidate: string): boolean {
  const tGlob = isGlob(target);
  const cGlob = isGlob(candidate);
  if (tGlob && cGlob) return globsOverlap(target, candidate);
  if (tGlob) return matchesPath(target, candidate);
  if (cGlob) return matchesPath(candidate, target);
  return target === candidate;
}
