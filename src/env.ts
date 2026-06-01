import path from "node:path";

/**
 * True when running as the compiled standalone binary (not `node`/`bun` from source).
 * Used by `upgrade` and `uninstall`, which only make sense for the installed binary.
 */
export function isStandaloneBinary(execPath: string = process.execPath): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base !== "node" && base !== "bun" && base !== "node.exe" && base !== "bun.exe";
}
