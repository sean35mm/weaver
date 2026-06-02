import fs from "node:fs";
import { STAMPED_VERSION } from "./version.generated.ts";

function packageVersion(): string | null {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Running from source reads package.json; standalone binaries fall back to the stamped constant. */
export const VERSION = packageVersion() ?? STAMPED_VERSION;
