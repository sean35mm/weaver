/**
 * Single source of truth for the CLI version. Released binaries are stamped with the real
 * version at build time (see .github/workflows/release-binaries.yml); in dev this literal may
 * lag package.json between releases, which only affects `--version` display (not `upgrade`,
 * which runs on stamped binaries only).
 */
export const VERSION = "0.1.0";
