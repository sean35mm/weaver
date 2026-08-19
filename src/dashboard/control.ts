import fs from "node:fs";
import net from "node:net";

export const DASHBOARD_CONTROL_PROTOCOL = 1;
export const DEFAULT_CONTROL_MAX_BYTES = 8 * 1024;
export const DEFAULT_CONTROL_TIMEOUT_MS = 1_000;
export const DEFAULT_CONTROL_FOCUS_TIMEOUT_MS = 5_000;

export type DashboardControlOp = "ping" | "focus" | "shutdown";
export type DashboardOwnerState = "starting" | "ready" | "shutting-down";
export type DashboardFocusHandler = () => boolean | Promise<boolean>;

export interface DashboardControlRequest {
  protocol: typeof DASHBOARD_CONTROL_PROTOCOL;
  repoId: string;
  ownerId: string;
  op: DashboardControlOp;
}

export interface DashboardControlResponse {
  protocol: typeof DASHBOARD_CONTROL_PROTOCOL;
  repoId: string;
  ownerId: string;
  state: DashboardOwnerState;
  ok: boolean;
  launchUrl?: string;
  error?: string;
}

export interface DashboardControlServerOptions {
  socketPath: string;
  repoId: string;
  ownerId: string;
  getState: () => DashboardOwnerState;
  getLaunchUrl?: () => string | undefined;
  focus?: DashboardFocusHandler;
  requestStop?: () => void | Promise<void>;
  maxBytes?: number;
  timeoutMs?: number;
  focusTimeoutMs?: number;
}

export interface DashboardControlServer {
  close(): Promise<void>;
}

export interface DashboardControlClientOptions {
  socketPath: string;
  repoId: string;
  ownerId: string;
  op: DashboardControlOp;
  maxBytes?: number;
  timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRequest(line: string): DashboardControlRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (value.protocol !== DASHBOARD_CONTROL_PROTOCOL) return undefined;
  if (typeof value.repoId !== "string" || typeof value.ownerId !== "string") return undefined;
  if (value.op !== "ping" && value.op !== "focus" && value.op !== "shutdown") return undefined;
  return value as unknown as DashboardControlRequest;
}

function parseResponse(line: string): DashboardControlResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("dashboard control returned malformed JSON");
  }
  if (!isObject(value)) throw new Error("dashboard control returned a malformed response");
  if (
    value.protocol !== DASHBOARD_CONTROL_PROTOCOL ||
    typeof value.repoId !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.ok !== "boolean" ||
    (value.state !== "starting" && value.state !== "ready" && value.state !== "shutting-down") ||
    (value.launchUrl !== undefined && typeof value.launchUrl !== "string") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("dashboard control returned a malformed response");
  }
  const response = value as unknown as DashboardControlResponse;
  if (
    (!response.ok && !validateFailedDashboardControlResponse(response)) ||
    (response.ok && response.error !== undefined)
  ) {
    throw new Error("dashboard control returned a semantically invalid response");
  }
  if (response.state !== "ready" && response.launchUrl !== undefined) {
    throw new Error("dashboard control returned a launch URL before readiness");
  }
  return response;
}

function encodedLine(value: unknown, maxBytes: number): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.length > maxBytes) throw new Error("dashboard control message is too large");
  return encoded;
}

function unlinkSocket(socketPath: string): void {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`dashboard control path is not a socket: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runBoundedFocus(focus: DashboardFocusHandler | undefined, timeoutMs: number): Promise<boolean> {
  if (!focus) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve()
      .then(focus)
      .then(
        (value) => finish(value === true),
        (error) => finish(false, error),
      );
  });
}

export async function startDashboardControlServer(
  options: DashboardControlServerOptions,
): Promise<DashboardControlServer> {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTROL_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const focusTimeoutMs = options.focusTimeoutMs ?? DEFAULT_CONTROL_FOCUS_TIMEOUT_MS;
  let listening = false;
  let focusInFlight: Promise<boolean> | undefined;
  const focus = (): Promise<boolean> => {
    if (focusInFlight) return focusInFlight;
    focusInFlight = runBoundedFocus(options.focus, focusTimeoutMs).finally(() => {
      focusInFlight = undefined;
    });
    return focusInFlight;
  };
  const server = net.createServer((socket) => {
    let bytes = 0;
    let pending = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => socket.destroy(new Error("dashboard control request timed out")), timeoutMs);
    const finish = (response: DashboardControlResponse): void => {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      try {
        socket.end(encodedLine(response, maxBytes));
      } catch {
        socket.destroy();
      }
    };
    const reject = (error: string): void =>
      finish({
        protocol: DASHBOARD_CONTROL_PROTOCOL,
        repoId: options.repoId,
        ownerId: options.ownerId,
        state: options.getState(),
        ok: false,
        error,
      });

    socket.on("data", (chunk: Buffer | Uint8Array) => {
      if (handled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        reject("request_too_large");
        return;
      }
      pending = Buffer.concat([pending, buffer]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== pending.length - 1) {
        reject("multiple_requests");
        return;
      }
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
      } catch {
        reject("malformed_request");
        return;
      }
      const request = parseRequest(line);
      if (!request) {
        reject("malformed_request");
        return;
      }
      if (request.repoId !== options.repoId || request.ownerId !== options.ownerId) {
        reject("identity_mismatch");
        return;
      }
      clearTimeout(timer);

      const perform = async (): Promise<void> => {
        if (request.op === "focus") {
          const focused = await focus();
          if (focused !== true) {
            reject("focus_unavailable");
            return;
          }
        }
        if (request.op === "shutdown") void Promise.resolve(options.requestStop?.()).catch(() => undefined);
        const response: DashboardControlResponse = {
          protocol: DASHBOARD_CONTROL_PROTOCOL,
          repoId: options.repoId,
          ownerId: options.ownerId,
          state: options.getState(),
          ok: true,
        };
        const launchUrl = options.getLaunchUrl?.();
        if (response.state === "ready" && launchUrl !== undefined) response.launchUrl = launchUrl;
        finish(response);
      };
      void perform().catch(() => reject("operation_failed"));
    });
    socket.once("error", () => clearTimeout(timer));
    socket.once("close", () => clearTimeout(timer));
  });

  try {
    await listen(server, options.socketPath);
    listening = true;
    fs.chmodSync(options.socketPath, 0o600);
    const stat = fs.lstatSync(options.socketPath);
    if (!stat.isSocket()) throw new Error(`dashboard control path is not a socket: ${options.socketPath}`);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (listening) unlinkSocket(options.socketPath);
    throw error;
  }
  server.on("error", () => {
    // An established server error is observed here so Node does not turn it into an uncaught exception.
  });
  let closing: Promise<void> | undefined;

  return {
    close(): Promise<void> {
      if (closing) return closing;
      closing = closeServer(server).finally(() => unlinkSocket(options.socketPath));
      return closing;
    },
  };
}

export function validateReadyDashboardControlResponse(
  response: DashboardControlResponse,
  expectedCapability?: string,
): response is DashboardControlResponse & { state: "ready"; ok: true; launchUrl: string } {
  if (!response.ok || response.state !== "ready" || response.error !== undefined || !response.launchUrl) return false;
  try {
    const url = new URL(response.launchUrl);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    const instance = url.searchParams.getAll("instance");
    const capabilityFragment = /^#cap=([A-Za-z0-9_-]+)$/.exec(url.hash);
    return (
      url.protocol === "http:" &&
      loopback &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      instance.length === 1 &&
      /^[A-Za-z0-9_-]{22}$/.test(instance[0]!) &&
      url.search === `?instance=${instance[0]}` &&
      capabilityFragment !== null &&
      (expectedCapability === undefined || capabilityFragment[1] === expectedCapability)
    );
  } catch {
    return false;
  }
}

export function validateFailedDashboardControlResponse(response: DashboardControlResponse): boolean {
  return (
    !response.ok && typeof response.error === "string" && response.error.length > 0 && response.launchUrl === undefined
  );
}

export function requestDashboardControl(options: DashboardControlClientOptions): Promise<DashboardControlResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTROL_MAX_BYTES;
  const timeoutMs =
    options.timeoutMs ?? (options.op === "focus" ? DEFAULT_CONTROL_FOCUS_TIMEOUT_MS : DEFAULT_CONTROL_TIMEOUT_MS);
  const request: DashboardControlRequest = {
    protocol: DASHBOARD_CONTROL_PROTOCOL,
    repoId: options.repoId,
    ownerId: options.ownerId,
    op: options.op,
  };
  const outgoing = encodedLine(request, maxBytes);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false;
    let bytes = 0;
    let pending = Buffer.alloc(0);
    const finish = (error?: Error, response?: DashboardControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response as DashboardControlResponse);
    };
    const timer = setTimeout(() => finish(new Error("dashboard control request timed out")), timeoutMs);
    socket.once("connect", () => socket.write(outgoing));
    socket.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        finish(new Error("dashboard control response is too large"));
        return;
      }
      pending = Buffer.concat([pending, buffer]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== pending.length - 1) {
        finish(new Error("dashboard control returned multiple responses"));
        return;
      }
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
        const response = parseResponse(line);
        if (response.repoId !== options.repoId || response.ownerId !== options.ownerId) {
          finish(new Error("dashboard control response identity mismatch"));
          return;
        }
        finish(undefined, response);
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("dashboard control closed without a response"));
    });
  });
}
