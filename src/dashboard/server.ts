/**
 * Tiny local HTTP + SSE server — a READ-ONLY human viewer over the store. Agents never talk
 * to it; it just polls the same SQLite file (~1s) and pushes snapshots. Loopback only.
 */

import http from "node:http";
import { DEFAULT_SESSION_TTL_MS } from "../store/reap.ts";
import { type StatusData, statusJson } from "../render.ts";
import type { Store } from "../store/store.ts";
import { PAGE } from "./page.ts";

export interface DashboardServer {
  url: string;
  close(): Promise<void>;
}

export interface StartOpts {
  store: Store;
  repoId: string;
  host?: string;
  port?: number;
  pollMs?: number;
  sessionTtlMs?: number;
}

function snapshot(store: Store, repoId: string, sessionTtlMs: number): string {
  const now = Date.now();
  const data: StatusData = {
    sessions: store.listActiveSessions(now, sessionTtlMs),
    claims: store.listActiveClaims(now),
    activity: store.listRecentActivity(50),
    notes: store.listNotes(50),
  };
  return JSON.stringify(statusJson(repoId, data, now, store));
}

function listenOn(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: unknown): void => {
      server.removeListener("listening", onOk);
      reject(e);
    };
    const onOk = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onOk);
    server.listen(port, host);
  });
}

export async function startDashboard(opts: StartOpts): Promise<DashboardServer> {
  const host = opts.host ?? "127.0.0.1";
  const pollMs = opts.pollMs ?? 1000;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const clients = new Set<{ res: http.ServerResponse; timer: ReturnType<typeof setInterval> }>();

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (): void => {
        res.write(`data: ${snapshot(opts.store, opts.repoId, sessionTtlMs)}\n\n`);
      };
      send(); // immediate first snapshot
      const timer = setInterval(send, pollMs);
      const client = { res, timer };
      clients.add(client);
      req.on("close", () => {
        clearInterval(timer);
        clients.delete(client);
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const preferred = opts.port ?? 7777;
  try {
    await listenOn(server, preferred, host);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE" && preferred !== 0) {
      await listenOn(server, 0, host);
    } else {
      throw e;
    }
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : preferred;
  const url = `http://${host}:${port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) {
          clearInterval(c.timer);
          c.res.end();
        }
        clients.clear();
        server.close(() => resolve());
      }),
  };
}
