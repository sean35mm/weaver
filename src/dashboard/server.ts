import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  type ScratchpadActor,
  type ScratchpadCaller,
  ScratchpadConflictError,
  ScratchpadError,
  ScratchpadService,
} from "../scratchpads/service.ts";
import { DEFAULT_SESSION_TTL_MS } from "../store/reap.ts";
import type { ScratchpadRevisionRow, ScratchpadRow, ScratchpadState, Store } from "../store/store.ts";
import { getDashboardCss, getDashboardJs } from "./assets.generated.ts";
import { PAGE } from "./page.ts";

const MAX_REQUEST_BYTES = 2_100_000;
const READ_TIMEOUT_MS = 5_000;
const MAX_EVENT_STREAMS = 8;
const STREAM_STALL_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_REQUESTS_PER_SOCKET = 100;
const MAX_CONNECTIONS = 32;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export interface DashboardServer {
  /** Public origin. It intentionally grants no API access. */
  url: string;
  /** One-launch URL; the app removes the fragment before making any requests. */
  launchUrl: string;
  close(): Promise<void>;
}

export interface StartOpts {
  store: Store;
  repoId: string;
  host?: string;
  port?: number;
  pollMs?: number;
  sessionTtlMs?: number;
  actor?: ScratchpadActor;
  caller?: ScratchpadCaller | null;
  isOwner?: () => boolean;
  now?: () => number;
}

class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
    this.code = code;
  }
}

function summary(pad: ScratchpadRow): Omit<ScratchpadRow, "body"> {
  const { body: _body, ...rest } = pad;
  return rest;
}

function revisionSummary(revision: ScratchpadRevisionRow): Omit<ScratchpadRevisionRow, "body"> {
  const { body: _body, ...rest } = revision;
  return rest;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType, ...extra });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpFailure(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new HttpFailure(413, "body_too_large", "request body is too large");
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        fail(new HttpFailure(413, "body_too_large", "request body is too large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpFailure(400, "invalid_json", "request body must be valid UTF-8 JSON"));
      }
    };
    const onError = (): void => fail(new HttpFailure(400, "request_error", "request body could not be read"));
    const onAborted = (): void => fail(new HttpFailure(400, "request_aborted", "request was aborted"));
    const timer = setTimeout(
      () => fail(new HttpFailure(408, "read_timeout", "request body timed out")),
      READ_TIMEOUT_MS,
    );
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpFailure(400, "invalid_body", "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpFailure(400, "invalid_body", `${key} must be a string`);
  return value;
}

function requiredRevision(body: Record<string, unknown>): number {
  const value = body.expectedRevision;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new HttpFailure(400, "invalid_body", "expectedRevision must be a positive integer");
  }
  return value as number;
}

function padId(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpFailure(404, "not_found", "not found");
  return value;
}

function statesFromUrl(url: URL): ScratchpadState[] | null {
  const state = url.searchParams.get("state") ?? "all";
  if (state === "all") return null;
  if (state === "active" || state === "archived" || state === "trash") return [state];
  throw new HttpFailure(400, "invalid_state", "state must be active, archived, trash, or all");
}

function listenOn(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startDashboard(opts: StartOpts): Promise<DashboardServer> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("dashboard host must be loopback");
  }
  const pollMs = opts.pollMs ?? 1000;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = opts.now ?? Date.now;
  const requestedActor =
    opts.actor ??
    ({
      kind: "human",
      sessionId: null,
      harness: null,
      provenance: "dashboard",
      worktreeId: null,
    } satisfies ScratchpadActor);
  const actor =
    requestedActor.sessionId && !opts.store.getSession(requestedActor.sessionId)
      ? { ...requestedActor, sessionId: null }
      : requestedActor;
  const service = new ScratchpadService(opts.store, now, sessionTtlMs);
  const capability = randomBytes(32).toString("base64url");
  const instance = randomBytes(16).toString("base64url");
  interface Stream {
    res: http.ServerResponse;
    timer: ReturnType<typeof setInterval> | null;
    stallTimer: ReturnType<typeof setTimeout> | null;
  }
  const streams = new Set<Stream>();
  let origin = "";

  const dashboardSnapshot = (): Record<string, unknown> => {
    const timestamp = now();
    return {
      repo: opts.repoId,
      now: timestamp,
      pads: service.list(null, 500).map(summary),
      sessions: opts.store.listActiveSessions(timestamp, sessionTtlMs),
      attachments: opts.store.listScratchpadAttachments(),
      claims: opts.store.listActiveClaims(timestamp).filter((claim) => claim.scratchpadId !== null),
      activity: opts.store.listRecentActivity(100).filter((event) => event.scratchpadId !== null),
      facts: opts.store.listNotes(100),
    };
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    if (opts.isOwner && !opts.isOwner()) {
      json(res, 503, { error: "ownership_lost", message: "dashboard ownership was lost" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, capability)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (streams.size >= MAX_EVENT_STREAMS) {
        json(res, 429, { error: "too_many_streams", message: "too many dashboard event streams" });
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "application/x-ndjson; charset=utf-8",
        connection: "keep-alive",
      });
      const stream: Stream = { res, timer: null, stallTimer: null };
      const cleanup = (): void => {
        if (stream.timer) clearInterval(stream.timer);
        if (stream.stallTimer) clearTimeout(stream.stallTimer);
        stream.timer = null;
        stream.stallTimer = null;
        streams.delete(stream);
      };
      const startPolling = (): void => {
        if (!stream.timer && !stream.stallTimer && !res.destroyed) stream.timer = setInterval(write, pollMs);
      };
      const write = (): void => {
        if (res.destroyed || res.writableEnded) {
          cleanup();
          return;
        }
        if (opts.isOwner && !opts.isOwner()) {
          cleanup();
          res.end();
          return;
        }
        if (res.write(`${JSON.stringify(dashboardSnapshot())}\n`)) return;
        if (stream.timer) clearInterval(stream.timer);
        stream.timer = null;
        if (!stream.stallTimer) {
          stream.stallTimer = setTimeout(() => {
            cleanup();
            res.destroy();
          }, STREAM_STALL_TIMEOUT_MS);
        }
        res.once("drain", () => {
          if (stream.stallTimer) clearTimeout(stream.stallTimer);
          stream.stallTimer = null;
          startPolling();
        });
      };
      streams.add(stream);
      write();
      startPolling();
      req.once("close", () => {
        cleanup();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      json(res, 200, dashboardSnapshot());
      return;
    }

    if (url.pathname === "/api/scratchpads" && req.method === "GET") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      const states = statesFromUrl(url);
      const pads = query ? service.find(query, states, 500) : service.list(states, 500);
      json(res, 200, { pads: pads.map(summary) });
      return;
    }

    if (url.pathname === "/api/scratchpads" && req.method === "POST") {
      if ((opts.store.getMeta("enabled") ?? "1") === "0") {
        throw new HttpFailure(
          423,
          "disabled",
          "Weaver is disabled; dashboard is read-only (`weaver enable` to resume)",
        );
      }
      const body = objectBody(await readJson(req));
      const created = service.create(requiredString(body, "title"), requiredString(body, "body"), actor);
      json(res, 201, { pad: created });
      return;
    }

    const match = /^\/api\/scratchpads\/(\d+)(?:\/(history|archive|restore|trash|recover))?$/.exec(url.pathname);
    if (!match) throw new HttpFailure(404, "not_found", "not found");
    const id = padId(match[1]!);
    const action = match[2];

    if (req.method === "GET" && !action) {
      const pad = service.get(id);
      json(res, 200, {
        pad,
        attachments: opts.store.listScratchpadAttachments(id),
        claims: opts.store.listActiveClaims(now()).filter((claim) => claim.scratchpadId === id),
        activity: opts.store
          .listRecentActivity(100)
          .filter((event) => event.scratchpadId === id)
          .slice(0, 30),
        history: service.history(id, 30).map(revisionSummary),
      });
      return;
    }

    if (req.method === "GET" && action === "history") {
      json(res, 200, { history: service.history(id, 100).map(revisionSummary) });
      return;
    }
    if (action === "history") throw new HttpFailure(405, "method_not_allowed", "method not allowed");

    if (req.method === "PUT" && !action) {
      if ((opts.store.getMeta("enabled") ?? "1") === "0") {
        throw new HttpFailure(
          423,
          "disabled",
          "Weaver is disabled; dashboard is read-only (`weaver enable` to resume)",
        );
      }
      const body = objectBody(await readJson(req));
      const expectedRevision = requiredRevision(body);
      const title = requiredString(body, "title");
      const markdown = requiredString(body, "body");
      const pad = service.updateIfChanged(id, title, markdown, expectedRevision, actor);
      json(res, 200, { pad, changed: pad.revision !== expectedRevision });
      return;
    }

    if (req.method === "POST" && action) {
      if ((opts.store.getMeta("enabled") ?? "1") === "0") {
        throw new HttpFailure(
          423,
          "disabled",
          "Weaver is disabled; dashboard is read-only (`weaver enable` to resume)",
        );
      }
      const body = objectBody(await readJson(req));
      const revision = requiredRevision(body);
      let pad: ScratchpadRow;
      if (action === "archive") pad = service.archive(id, revision, actor, opts.caller ?? null);
      else if (action === "restore") pad = service.restore(id, revision, actor);
      else if (action === "trash") {
        const reason = body.reason === undefined ? null : requiredString(body, "reason");
        pad = service.trash(id, revision, actor, opts.caller ?? null, reason);
      } else if (action === "recover") pad = service.recover(id, revision, actor);
      else throw new HttpFailure(405, "method_not_allowed", "method not allowed");
      json(res, 200, { pad });
      return;
    }

    throw new HttpFailure(405, "method_not_allowed", "method not allowed");
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!origin || req.headers.host !== origin.slice("http://".length)) {
          throw new HttpFailure(403, "invalid_host", "invalid Host header");
        }
        const requestOrigin = req.headers.origin;
        if (requestOrigin !== undefined && requestOrigin !== origin) {
          throw new HttpFailure(403, "invalid_origin", "invalid Origin header");
        }
        if (!req.url || req.url.length > 4096) throw new HttpFailure(414, "uri_too_long", "request URI is too long");
        const url = new URL(req.url, origin);

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          send(res, 200, PAGE, "text/html; charset=utf-8");
          return;
        }
        if (req.method === "GET" && url.pathname === "/assets/app.js") {
          send(res, 200, getDashboardJs(), "text/javascript; charset=utf-8");
          return;
        }
        if (req.method === "GET" && url.pathname === "/assets/app.css") {
          send(res, 200, getDashboardCss(), "text/css; charset=utf-8");
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          await handleApi(req, res, url);
          return;
        }
        throw new HttpFailure(404, "not_found", "not found");
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof ScratchpadConflictError) {
          json(res, 409, {
            error: "stale_revision",
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          });
          return;
        }
        if (error instanceof HttpFailure) {
          json(res, error.status, { error: error.code, message: error.message });
          return;
        }
        if (error instanceof ScratchpadError) {
          json(res, /not found/.test(error.message) ? 404 : 400, { error: "scratchpad_error", message: error.message });
          return;
        }
        json(res, 500, { error: "internal_error" });
      }
    })();
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
  server.maxConnections = MAX_CONNECTIONS;

  const preferred = opts.port ?? 7777;
  try {
    await listenOn(server, preferred, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE" && preferred !== 0) await listenOn(server, 0, host);
    else throw error;
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : preferred;
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  let closing: Promise<void> | undefined;
  return {
    url: origin,
    launchUrl: `${origin}/?instance=${instance}#cap=${capability}`,
    close: () => {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        for (const stream of streams) {
          if (stream.timer) clearInterval(stream.timer);
          if (stream.stallTimer) clearTimeout(stream.stallTimer);
          stream.res.end();
        }
        streams.clear();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
