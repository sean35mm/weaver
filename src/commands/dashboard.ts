import { spawn } from "node:child_process";
import { flagBool, flagStr } from "../args.ts";
import type { Ctx } from "../context.ts";
import { startDashboard } from "../dashboard/server.ts";
import { claimsByLiveHolders, formatStatus, type StatusData } from "../render.ts";
import { DEFAULT_COMPLETED_SESSION_RECENT_MS } from "../store/reap.ts";
import { themeFromCtx } from "../terminal/color.ts";
import { CliError } from "../validate.ts";

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
  try {
    // macOS/Linux only — Weaver ships no native Windows binary (WSL2 takes the linux path).
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort — the URL is printed regardless */
  }
}

export function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("port must be an integer between 0 and 65535");
  }
  return port;
}

export async function runDashboard(ctx: Ctx): Promise<number> {
  const port = parsePort(flagStr(ctx.args, "port"));
  const theme = themeFromCtx(ctx);

  const server = await startDashboard({
    store: ctx.store,
    repoId: ctx.repo.repoId,
    port,
    sessionTtlMs: ctx.config.sessionTtlMs,
  });
  ctx.out(
    `${theme.accent("weaver dashboard")} ${theme.dim("→")} ${theme.path(server.url)}   ${theme.dim("(Ctrl-C to stop)")}\n`,
  );
  if (!flagBool(ctx.args, "no-open")) openBrowser(server.url);

  await waitForSignal();
  await server.close();
  ctx.out(`\n${theme.success("✓ dashboard stopped")}\n`);
  return 0;
}

export async function runWatch(ctx: Ctx): Promise<number> {
  const theme = themeFromCtx(ctx);
  const draw = (): void => {
    const now = Date.now();
    const sessions = ctx.store.listActiveSessions(now, ctx.config.sessionTtlMs);
    const data: StatusData = {
      sessions,
      completed: ctx.store.listRecentEndedSessions(5, now - DEFAULT_COMPLETED_SESSION_RECENT_MS),
      claims: claimsByLiveHolders(ctx.store.listActiveClaims(now), sessions),
      activity: ctx.store.listRecentActivity(12),
      notes: ctx.store.listNotes(8),
    };
    const empty =
      !data.sessions.length &&
      !data.completed.length &&
      !data.claims.length &&
      !data.activity.length &&
      !data.notes.length;
    const body = empty ? `${theme.dim("no activity")}\n` : formatStatus(data, now, ctx.store, theme);
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + cursor home
    process.stdout.write(
      `🧵 ${theme.accent("weaver watch")} ${theme.dim("—")} ${theme.dim(ctx.repo.repoId)}   ${theme.dim("(Ctrl-C to stop)")}\n\n${body}`,
    );
  };

  draw();
  const timer = setInterval(draw, 1000);
  await waitForSignal();
  clearInterval(timer);
  process.stdout.write("\n");
  return 0;
}
