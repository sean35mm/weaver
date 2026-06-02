import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { flagBool } from "../args.ts";
import type { Ctx } from "../context.ts";
import { isStandaloneBinary } from "../env.ts";
import { VERSION } from "../version.ts";

const REPO = "sean35mm/weaver";

/** The release asset name for the current platform, or null if unsupported. */
function platformAsset(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && arch ? `weaver-${os}-${arch}` : null;
}

export function parseSha256(text: string): string | null {
  const hash = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function run(ctx: Ctx): Promise<number> {
  if (!isStandaloneBinary()) {
    ctx.err("weaver: `upgrade` only applies to the standalone (curl-installed) binary.\n");
    ctx.err("  You appear to be running from source. Install the binary with:\n");
    ctx.err(`  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh\n`);
    return 1;
  }

  const asset = platformAsset();
  if (!asset) {
    ctx.err(`weaver: unsupported platform ${process.platform}/${process.arch}\n`);
    return 1;
  }

  let latest = "";
  let latestTag = "";
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "weaver-upgrade", accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latestTag = ((await res.json()) as { tag_name?: string }).tag_name ?? "";
    latest = latestTag.replace(/^v/, "");
  } catch (e) {
    ctx.err(`weaver: couldn't check the latest version: ${(e as Error).message}\n`);
    return 1;
  }
  if (!latest || !latestTag) {
    ctx.err("weaver: no published release found\n");
    return 1;
  }

  ctx.out(`current ${VERSION}  ·  latest ${latest}\n`);
  if (latest === VERSION) {
    ctx.out("✓ already up to date\n");
    return 0;
  }
  if (flagBool(ctx.args, "check")) {
    ctx.out(`a newer version (${latest}) is available — run 'weaver upgrade'\n`);
    return 0;
  }

  ctx.out(`downloading ${asset} ${latest}…\n`);
  let bytes: Uint8Array;
  let expectedHash: string | null;
  try {
    const [assetRes, checksumRes] = await Promise.all([
      fetch(`https://github.com/${REPO}/releases/download/${encodeURIComponent(latestTag)}/${asset}`),
      fetch(`https://github.com/${REPO}/releases/download/${encodeURIComponent(latestTag)}/${asset}.sha256`),
    ]);
    if (!assetRes.ok) throw new Error(`binary HTTP ${assetRes.status}`);
    if (!checksumRes.ok) throw new Error(`checksum HTTP ${checksumRes.status}`);
    bytes = new Uint8Array(await assetRes.arrayBuffer());
    expectedHash = parseSha256(await checksumRes.text());
  } catch (e) {
    ctx.err(`weaver: download failed: ${(e as Error).message}\n`);
    return 1;
  }
  if (!expectedHash) {
    ctx.err("weaver: download failed: invalid checksum file\n");
    return 1;
  }
  const actualHash = sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    ctx.err("weaver: download failed: checksum mismatch\n");
    return 1;
  }

  // Atomic in-place replace: write next to the target, then rename over it. On Unix this
  // works even while the binary is executing (the running process keeps the old inode).
  const target = process.execPath;
  const tmp = path.join(path.dirname(target), `.weaver-upgrade-${process.pid}`);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    const code = (e as NodeJS.ErrnoException).code;
    const hint =
      code === "EACCES" || code === "EPERM"
        ? `no write permission to ${target} — try \`sudo weaver upgrade\` or re-run install.sh`
        : (e as Error).message;
    ctx.err(`weaver: couldn't replace the binary: ${hint}\n`);
    return 1;
  }

  ctx.out(`✓ upgraded to ${latest}\n`);
  return 0;
}
