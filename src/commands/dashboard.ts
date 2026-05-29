import { spawn } from "node:child_process";
import { flagBool, flagStr } from "../args.ts";
import type { Ctx } from "../context.ts";
import { startDashboard } from "../dashboard/server.ts";
import { formatStatus, type StatusData } from "../render.ts";

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (): void => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
      resolve();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort — the URL is printed regardless */
  }
}

export async function runDashboard(ctx: Ctx): Promise<number> {
  const portRaw = flagStr(ctx.args, "port");
  const port = portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : undefined;

  const server = await startDashboard({
    store: ctx.store,
    repoId: ctx.repo.repoId,
    port,
    sessionTtlMs: ctx.config.sessionTtlMs,
  });
  ctx.out(`weaver dashboard → ${server.url}   (Ctrl-C to stop)\n`);
  if (!flagBool(ctx.args, "no-open")) openBrowser(server.url);

  await waitForSignal();
  await server.close();
  ctx.out("\n✓ dashboard stopped\n");
  return 0;
}

export async function runWatch(ctx: Ctx): Promise<number> {
  const draw = (): void => {
    const now = Date.now();
    const data: StatusData = {
      sessions: ctx.store.listActiveSessions(now, ctx.config.sessionTtlMs),
      claims: ctx.store.listActiveClaims(now),
      activity: ctx.store.listRecentActivity(12),
      notes: ctx.store.listNotes(8),
    };
    const empty = !data.sessions.length && !data.claims.length && !data.activity.length && !data.notes.length;
    const body = empty ? "no activity\n" : formatStatus(data, now, ctx.store);
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + cursor home
    process.stdout.write(`🧵 weaver watch — ${ctx.repo.repoId}   (Ctrl-C to stop)\n\n${body}`);
  };

  draw();
  const timer = setInterval(draw, 1000);
  await waitForSignal();
  clearInterval(timer);
  process.stdout.write("\n");
  return 0;
}
