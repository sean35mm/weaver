import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import {
  type CmuxBrowserSurface,
  type DashboardLauncherDeps,
  findNewCmuxBrowserSurface,
  launchDashboard,
  matchesCmuxSurfaceUrlIdentity,
  parseCmuxBrowserSurfaces,
  parseOpenMode,
  parsePort,
  runDashboard,
} from "../src/commands/dashboard.ts";
import { run as runTask } from "../src/commands/task.ts";
import type { Ctx } from "../src/context.ts";
import type { DashboardOwner } from "../src/dashboard/ownership.ts";
import { type DashboardServer, startDashboard } from "../src/dashboard/server.ts";
import { ScratchpadService } from "../src/scratchpads/service.ts";
import { openStore } from "../src/store/open.ts";

const INSTANCE_MARKER = "AAAAAAAAAAAAAAAAAAAAAA";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "weaver-dash-")), "s.db");
}

function auth(server: DashboardServer): string {
  const token = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("cap");
  assert.ok(token);
  return `Bearer ${token}`;
}

function dashboardCtx(store: Awaited<ReturnType<typeof openStore>>): Ctx {
  return {
    store,
    identity: null,
    repo: { repoId: "r1", root: "/repo", basis: "path" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: "/repo",
    now: 1_000,
    env: {},
    args: parseArgs(["dashboard", "--no-open"]),
    out: () => undefined,
    err: () => undefined,
  };
}

async function api(
  server: DashboardServer,
  pathname: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", auth(server));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${server.url}${pathname}`, { ...init, headers });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function rawRequest(
  server: DashboardServer,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const target = new URL(pathname, server.url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("dashboard assets define a validated dark-default theme with an explicit light override", () => {
  const appSource = fs.readFileSync(new URL("../web/dashboard/app.ts", import.meta.url), "utf8");
  const stylesheet = fs.readFileSync(new URL("../web/dashboard/app.css", import.meta.url), "utf8");

  assert.match(stylesheet, /^:root\s*{\s*color-scheme:\s*dark;/);
  assert.match(stylesheet, /:root\[data-theme="light"\]\s*{[^}]*color-scheme:\s*light;/s);
  assert.match(appSource, /<label class="theme-control" for="theme">/);
  assert.match(appSource, /<select id="theme" aria-label="Dashboard theme">/);
  assert.match(appSource, /<option value="dark">Dark<\/option><option value="light">Light<\/option>/);

  assert.match(appSource, /const THEME_STORAGE_KEY = "weaver-dashboard-theme";/);
  assert.match(appSource, /stored === "dark" \|\| stored === "light" \? stored : "dark"/);
  assert.match(appSource, /catch \{\s*return "dark";/);
  assert.match(appSource, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/);
  assert.doesNotMatch(appSource, /localStorage\.(?:getItem|setItem)\((?!THEME_STORAGE_KEY)/);

  assert.match(appSource, /toastui-editor-dark\.css/);
  assert.match(appSource, /theme: currentTheme/);
  assert.match(appSource, /editorElement\.classList\.toggle\("toastui-editor-dark", theme === "dark"\)/);
  assert.match(stylesheet, /\.mark\s*{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-ink\);/s);
  assert.doesNotMatch(stylesheet, /\.mark\s*{[^}]*color:\s*white;/s);
  assert.match(
    stylesheet,
    /@media \(max-width:\s*1120px\)\s*{[^}]*\.document-actions\s*{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;/s,
  );
  assert.match(stylesheet, /\.empty-state:not\(\[hidden\]\)\s*{\s*display:\s*flex;/);
  assert.doesNotMatch(stylesheet, /\.empty-state\s*{[^}]*display:\s*flex/);
});

test("dashboard fails closed before ownership election while maintenance is active", async () => {
  const store = await openStore(tmpDb());
  let elected = false;
  try {
    assert.equal(
      await runDashboard(dashboardCtx(store), {
        ensureRuntime: () => ({ scopeId: "scope", directory: "/runtime", socketPath: "/runtime/control" }),
        isMaintenanceActive: async () => true,
        coordinateOwnership: async () => {
          elected = true;
          throw new Error("should not elect");
        },
        startServer: startDashboard,
        launch: launchDashboard,
      }),
      1,
    );
    assert.equal(elected, false);
  } finally {
    store.close();
  }
});

test("dashboard releases an acquired owner when maintenance appears after election", async () => {
  const store = await openStore(tmpDb());
  let checks = 0;
  let closed = 0;
  let started = false;
  const owner: DashboardOwner = {
    kind: "owner",
    ownerId: "owner",
    socketPath: "/runtime/control",
    stopped: new Promise(() => undefined),
    getState: () => "starting",
    isCurrent: () => true,
    ready: async () => undefined,
    close: async () => {
      closed++;
    },
  };
  try {
    assert.equal(
      await runDashboard(dashboardCtx(store), {
        ensureRuntime: () => ({ scopeId: "scope", directory: "/runtime", socketPath: "/runtime/control" }),
        isMaintenanceActive: async () => ++checks === 2,
        coordinateOwnership: async () => owner,
        startServer: async () => {
          started = true;
          throw new Error("should not start HTTP");
        },
        launch: launchDashboard,
      }),
      1,
    );
    assert.equal(closed, 1);
    assert.equal(started, false);
  } finally {
    store.close();
  }
});

test("runDashboard publishes readiness only after its launcher resolves and focus reaches the handle", async () => {
  const store = await openStore(tmpDb());
  const events: string[] = [];
  const output: string[] = [];
  let focusOwner: (() => boolean | Promise<boolean>) | undefined;
  let releaseLaunch!: () => void;
  let announceStartupAdvanced!: () => void;
  let resolveStopped!: (stop: { reason: "shutdown-requested" }) => void;
  let shuttingDown = false;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const startupAdvanced = new Promise<void>((resolve) => {
    announceStartupAdvanced = resolve;
  });
  const stopped = new Promise<{ reason: "shutdown-requested" }>((resolve) => {
    resolveStopped = resolve;
  });
  const owner: DashboardOwner = {
    kind: "owner",
    ownerId: "owner",
    socketPath: "/runtime/control",
    stopped,
    getState: () => (shuttingDown ? "shutting-down" : "starting"),
    isCurrent: () => true,
    ready: async () => {
      events.push("ready");
      assert.ok(focusOwner);
      const focused = await focusOwner();
      shuttingDown = true;
      resolveStopped({ reason: "shutdown-requested" });
      announceStartupAdvanced();
      assert.equal(focused, true);
    },
    close: async () => {
      events.push("ownership-close");
    },
  };
  const ctx = dashboardCtx(store);
  ctx.args = parseArgs(["dashboard"]);
  ctx.out = (text) => output.push(text);

  try {
    const running = runDashboard(ctx, {
      ensureRuntime: () => ({ scopeId: "scope", directory: "/runtime", socketPath: "/runtime/control" }),
      isMaintenanceActive: async () => false,
      coordinateOwnership: async (options) => {
        focusOwner = options.focus;
        return owner;
      },
      startServer: async () => {
        events.push("server-start");
        return {
          url: "http://127.0.0.1:1234/",
          launchUrl: `http://127.0.0.1:1234/?instance=${INSTANCE_MARKER}#cap=secret`,
          close: async () => {
            events.push("server-close");
          },
        };
      },
      launch: async () => {
        events.push("launch-start");
        announceStartupAdvanced();
        await launchGate;
        events.push("launch-resolved");
        return {
          kind: "cmux",
          managed: true,
          surfaceId: "owned-uuid",
          focus: async () => {
            events.push("focus");
            return true;
          },
          close: async () => {
            events.push("launch-close");
          },
        };
      },
    });

    await startupAdvanced;
    assert.deepEqual(events, ["server-start", "launch-start"]);
    assert.deepEqual(output, []);
    releaseLaunch();
    assert.equal(await running, 0);
    assert.deepEqual(events, [
      "server-start",
      "launch-start",
      "launch-resolved",
      "ready",
      "focus",
      "server-close",
      "launch-close",
      "ownership-close",
    ]);
    assert.deepEqual(output, []);
  } finally {
    store.close();
  }
});

test("runDashboard cleans up the server and ownership when launch fails before readiness", async () => {
  const store = await openStore(tmpDb());
  const events: string[] = [];
  const owner: DashboardOwner = {
    kind: "owner",
    ownerId: "owner",
    socketPath: "/runtime/control",
    stopped: new Promise(() => undefined),
    getState: () => "starting",
    isCurrent: () => true,
    ready: async () => {
      events.push("ready");
    },
    close: async () => {
      events.push("ownership-close");
    },
  };
  const ctx = dashboardCtx(store);
  ctx.args = parseArgs(["dashboard"]);

  try {
    await assert.rejects(
      runDashboard(ctx, {
        ensureRuntime: () => ({ scopeId: "scope", directory: "/runtime", socketPath: "/runtime/control" }),
        isMaintenanceActive: async () => false,
        coordinateOwnership: async () => owner,
        startServer: async () => {
          events.push("server-start");
          return {
            url: "http://127.0.0.1:1234/",
            launchUrl: `http://127.0.0.1:1234/?instance=${INSTANCE_MARKER}#cap=secret`,
            close: async () => {
              events.push("server-close");
            },
          };
        },
        launch: async () => {
          events.push("launch");
          throw new Error("launch failed");
        },
      }),
      /launch failed/,
    );
    assert.deepEqual(events, ["server-start", "launch", "server-close", "ownership-close"]);
  } finally {
    store.close();
  }
});

test("public shell is data-free and assets use a strict external-only policy", async () => {
  const store = await openStore(tmpDb());
  store.createScratchpad({ title: "private title", body: "private body", createdAt: Date.now() });
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    const page = await fetch(server.url);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Weaver Scratchpads/);
    assert.match(html, /src="\/assets\/app\.js"/);
    assert.match(html, /href="\/assets\/app\.css"/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)/);
    assert.doesNotMatch(html, /private title|private body|#cap=/);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /style-src-attr 'unsafe-inline'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline|style-src 'self'[^;]*unsafe-inline|https?:/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");

    const [js, css] = await Promise.all([fetch(`${server.url}/assets/app.js`), fetch(`${server.url}/assets/app.css`)]);
    assert.equal(js.status, 200);
    assert.equal(css.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const javascript = await js.text();
    assert.ok(javascript.length > 100_000, "the locally bundled rich editor ships in the asset");
    assert.match(javascript, /customHTMLSanitizer/);
    assert.match(javascript, /customHTMLRenderer/);
    assert.match(javascript, /FORBID_TAGS/);
    assert.match(javascript, /mailto:/);
    assert.match(
      javascript,
      /\[\$\{.*\}\]/,
      "the bundled image renderer emits inert alt text rather than an image node",
    );
    assert.match(javascript, /noopener noreferrer/);
    assert.match(javascript, /Revision conflict/);
    assert.match(javascript, /Discard the unsaved local draft and create a new scratchpad/);
    const stylesheet = await css.text();
    assert.match(stylesheet, /toastui-editor/);
    assert.match(stylesheet, /\.toastui-editor-dark\.toastui-editor-defaultUI/);
    assert.match(stylesheet, /:root\{color-scheme:dark;/);
    assert.match(stylesheet, /:root\[data-theme=light\]\{color-scheme:light;/);
    assert.match(stylesheet, /\.empty-state:not\(\[hidden\]\)\{display:flex\}/);
    assert.doesNotMatch(stylesheet, /\.empty-state\{[^}]*display:flex/);
    assert.match(stylesheet, /\.conflict:not\(\[hidden\]\)\{display:flex\}/);
    assert.doesNotMatch(stylesheet, /\.conflict\{[^}]*display:flex/);
    assert.match(javascript, /weaver-dashboard-theme/);
    assert.match(javascript, /Dashboard theme/);
    assert.match(javascript, /toastui-editor-dark/);
  } finally {
    await server.close();
    store.close();
  }
});

test("launch URLs use a random persistent instance marker while keeping the capability in memory", async () => {
  const dbPath = tmpDb();
  const store = await openStore(dbPath);
  const first = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  const second = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  let capability = "";
  try {
    const firstUrl = new URL(first.launchUrl);
    const secondUrl = new URL(second.launchUrl);
    assert.equal(first.url, firstUrl.origin);
    assert.equal(firstUrl.pathname, "/");
    assert.deepEqual([...firstUrl.searchParams.keys()], ["instance"]);
    assert.match(firstUrl.searchParams.get("instance") ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(firstUrl.searchParams.get("instance"), secondUrl.searchParams.get("instance"));
    assert.match(firstUrl.hash, /^#cap=[A-Za-z0-9_-]+$/);
    capability = new URLSearchParams(firstUrl.hash.slice(1)).get("cap") ?? "";
    assert.ok(capability);
    assert.equal(first.url.includes(capability), false);

    const appSource = fs.readFileSync(new URL("../web/dashboard/app.ts", import.meta.url), "utf8");
    assert.match(
      appSource,
      /history\.replaceState\(null, "", `\$\{location\.pathname\}\$\{location\.search\}`\);/,
      "the app removes only the capability fragment and retains the instance query",
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
    store.close();
  }

  for (const entry of fs.readdirSync(path.dirname(dbPath))) {
    const contents = fs.readFileSync(path.join(path.dirname(dbPath), entry));
    assert.equal(contents.includes(Buffer.from(capability)), false, `capability must not be persisted in ${entry}`);
  }
});

test("API requires its in-memory bearer capability and validates Host and Origin", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    const unauthorized = await fetch(`${server.url}/api/snapshot`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

    const badOrigin = await fetch(`${server.url}/api/snapshot`, {
      headers: { authorization: auth(server), origin: "https://attacker.invalid" },
    });
    assert.equal(badOrigin.status, 403);

    const badHost = await rawRequest(server, "/api/snapshot", {
      authorization: auth(server),
      host: "attacker.invalid",
    });
    assert.equal(badHost.status, 403);
    assert.match(badHost.body, /invalid_host/);
  } finally {
    await server.close();
    store.close();
  }
});

test("dashboard refuses non-loopback bindings", async () => {
  const store = await openStore(tmpDb());
  try {
    await assert.rejects(startDashboard({ store, repoId: "r1", host: "0.0.0.0", port: 0 }), /must be loopback/);
  } finally {
    store.close();
  }
});

test("scratchpad API keeps list and stream bodies bounded to metadata and enforces revision CAS", async () => {
  let now = 1_000;
  const store = await openStore(tmpDb());
  const server = await startDashboard({
    store,
    repoId: "r1",
    host: "127.0.0.1",
    port: 0,
    pollMs: 50,
    now: () => ++now,
  });
  try {
    const markdown = "# Heading\n\n- [ ] task\n\n<script>alert(1)</script>\n\n![remote](https://example.invalid/x.png)";
    const created = await api(server, "/api/scratchpads", {
      method: "POST",
      body: JSON.stringify({ title: "Secure pad", body: markdown }),
    });
    assert.equal(created.response.status, 201);
    const pad = created.body.pad as { id: number; revision: number; body: string };
    assert.equal(pad.revision, 1);
    assert.equal(pad.body, markdown, "canonical storage remains Markdown; rendering is sanitized in the editor");

    const listed = await api(server, "/api/scratchpads?state=all&q=task");
    assert.equal(listed.response.status, 200);
    const listedPad = (listed.body.pads as Record<string, unknown>[])[0]!;
    assert.equal(listedPad.title, "Secure pad");
    assert.equal("body" in listedPad, false);

    const snapshot = await api(server, "/api/snapshot");
    assert.equal("body" in (snapshot.body.pads as Record<string, unknown>[])[0]!, false);

    const stream = await fetch(`${server.url}/api/events`, { headers: { authorization: auth(server) } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    const event = JSON.parse(new TextDecoder().decode(chunk.value).split("\n")[0]!) as {
      pads: Record<string, unknown>[];
    };
    assert.equal("body" in event.pads[0]!, false);
    await reader.cancel();

    const noOp = await api(server, `/api/scratchpads/${pad.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Secure pad", body: markdown, expectedRevision: 1 }),
    });
    assert.equal((noOp.body.pad as { revision: number }).revision, 1);
    assert.equal(noOp.body.changed, false);

    const updated = await api(server, `/api/scratchpads/${pad.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Renamed", body: `${markdown}\n\nnew`, expectedRevision: 1 }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal((updated.body.pad as { revision: number }).revision, 2);

    const stale = await api(server, `/api/scratchpads/${pad.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Stale", body: "local draft", expectedRevision: 1 }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error, "stale_revision");
    assert.equal(stale.body.actualRevision, 2);

    const detail = await api(server, `/api/scratchpads/${pad.id}`);
    assert.equal((detail.body.pad as { title: string; body: string }).title, "Renamed");
    assert.equal((detail.body.pad as { title: string; body: string }).body, `${markdown}\n\nnew`);
    assert.equal("body" in (detail.body.history as Record<string, unknown>[])[0]!, false);
  } finally {
    await server.close();
    store.close();
  }
});

test("lifecycle API supports archive, restore, trash, and recovery", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    const created = await api(server, "/api/scratchpads", {
      method: "POST",
      body: JSON.stringify({ title: "Lifecycle", body: "body" }),
    });
    const id = (created.body.pad as { id: number }).id;
    const invalidHistoryMutation = await api(server, `/api/scratchpads/${id}/history`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(invalidHistoryMutation.response.status, 405);
    let revision = 1;
    for (const action of ["archive", "restore", "trash", "recover"] as const) {
      const result = await api(server, `/api/scratchpads/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision, reason: action === "trash" ? "test" : undefined }),
      });
      assert.equal(result.response.status, 200);
      revision = (result.body.pad as { revision: number }).revision;
    }
    const detail = await api(server, `/api/scratchpads/${id}`);
    assert.equal((detail.body.pad as { state: string }).state, "active");
    assert.equal((detail.body.pad as { revision: number }).revision, 5);
  } finally {
    await server.close();
    store.close();
  }
});

test("task activity follows the attached scratchpad into dashboard context", async () => {
  const store = await openStore(tmpDb());
  store.upsertSession(
    { id: "agent-a", harness: "test", idSource: "explicit", pid: null, cwd: "/repo", worktreeId: "wt-a" },
    1_000,
  );
  const pad = store.createScratchpad({ title: "Attached work", body: "", createdAt: 1_000 });
  new ScratchpadService(store, () => 1_000).use(pad.id, { sessionId: "agent-a", worktreeId: "wt-a" });
  const ctx: Ctx = {
    store,
    identity: { key: "agent-a", source: "explicit", label: "test" },
    repo: { repoId: "r1", root: "/repo", basis: "path", worktreeId: "wt-a" },
    config: { sessionTtlMs: 300_000, claimTtlMs: 1_800_000, recentMs: 1_200_000 },
    cwd: "/repo",
    now: 1_001,
    env: {},
    args: parseArgs(["task", "finish attached work"]),
    out: () => undefined,
    err: () => undefined,
  };
  assert.equal(runTask(ctx), 0);
  assert.equal(store.listRecentActivity(10)[0]?.scratchpadId, pad.id);

  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    const result = await api(server, `/api/scratchpads/${pad.id}`);
    const task = (result.body.activity as Array<{ kind: string; scratchpadId: number; summary: string }>).find(
      (event) => event.kind === "task",
    );
    assert.equal(task?.scratchpadId, pad.id);
    assert.equal(task?.summary, "finish attached work");
  } finally {
    await server.close();
    store.close();
  }
});

test("dashboard mutations become read-only immediately when Weaver is disabled", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    store.setMeta("enabled", "0");
    const snapshot = await api(server, "/api/snapshot");
    assert.equal(snapshot.response.status, 200);
    const create = await api(server, "/api/scratchpads", {
      method: "POST",
      body: JSON.stringify({ title: "blocked", body: "" }),
    });
    assert.equal(create.response.status, 423);
    assert.equal(create.body.error, "disabled");
    assert.match(String(create.body.message), /read-only/);
  } finally {
    await server.close();
    store.close();
  }
});

test("dashboard safely nulls an attributed human actor without a sessions row", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({
    store,
    repoId: "r1",
    host: "127.0.0.1",
    port: 0,
    actor: { kind: "human", sessionId: "observer", harness: "test", provenance: "dashboard", worktreeId: "wt" },
  });
  try {
    const created = await api(server, "/api/scratchpads", {
      method: "POST",
      body: JSON.stringify({ title: "human", body: "" }),
    });
    assert.equal(created.response.status, 201);
    const id = (created.body.pad as { id: number }).id;
    assert.equal(store.listScratchpadRevisions(id, 1)[0]?.actorId, null);
    assert.equal(store.getSession("observer"), undefined);
  } finally {
    await server.close();
    store.close();
  }
});

test("dashboard caps concurrent authenticated event streams", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0, pollMs: 10_000 });
  const streams: Response[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      streams.push(await fetch(`${server.url}/api/events`, { headers: { authorization: auth(server) } }));
    }
    assert.ok(streams.every((response) => response.status === 200));
    const rejected = await api(server, "/api/events");
    assert.equal(rejected.response.status, 429);
    assert.equal(rejected.body.error, "too_many_streams");
  } finally {
    await Promise.all(streams.map((response) => response.body?.cancel()));
    await server.close();
    store.close();
  }
});

test("JSON mutations reject unsupported and oversized request bodies", async () => {
  const store = await openStore(tmpDb());
  const server = await startDashboard({ store, repoId: "r1", host: "127.0.0.1", port: 0 });
  try {
    const unsupported = await fetch(`${server.url}/api/scratchpads`, {
      method: "POST",
      headers: { authorization: auth(server), "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(unsupported.status, 415);

    const oversized = await fetch(`${server.url}/api/scratchpads`, {
      method: "POST",
      headers: { authorization: auth(server), "content-type": "application/json" },
      body: "x".repeat(2_100_001),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.close();
    store.close();
  }
});

function cmuxTree(
  workspaceId: string,
  surfaces: Array<{ id: string; ref: string; type: string; url: string | null }>,
): string {
  return JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: workspaceId,
            ref: "workspace:7",
            panes: [{ surfaces }],
          },
        ],
      },
    ],
  });
}

function launcherDeps(
  deps: Omit<DashboardLauncherDeps, "runAsync"> & Partial<Pick<DashboardLauncherDeps, "runAsync">>,
): DashboardLauncherDeps {
  const hasUnsupportedUuidSelector = (args: string[]): boolean => {
    const selectorFlag =
      args[0] === "focus-panel" ? "--panel" : args[0] === "browser" || args[0] === "close-surface" ? "--surface" : null;
    if (!selectorFlag) return false;
    const selector = args[args.indexOf(selectorFlag) + 1];
    return selector !== undefined && !selector.startsWith("surface:");
  };
  const run: DashboardLauncherDeps["run"] = (command, args, cwd) => {
    const result = deps.run(command, args, cwd);
    return hasUnsupportedUuidSelector(args) ? { ok: false, stdout: result.stdout } : result;
  };
  return {
    ...deps,
    run,
    runAsync: deps.runAsync
      ? async (command, args, cwd) => {
          const result = await deps.runAsync!(command, args, cwd);
          return hasUnsupportedUuidSelector(args) ? { ok: false, stdout: result.stdout } : result;
        }
      : async (command, args, cwd) => run(command, args, cwd),
  };
}

test("launcher follows cmux ref churn and idempotently closes exactly its stable surface identity", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  let opened = false;
  const launchUrl = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const currentUrl = `http://127.0.0.1/?instance=${INSTANCE_MARKER}`;
  const before = cmuxTree("w", [
    { id: "source", ref: "surface:1", type: "terminal", url: null },
    { id: "existing", ref: "surface:2", type: "browser", url: `http://127.0.0.1:1/?instance=${INSTANCE_MARKER}` },
  ]);
  const after = cmuxTree("w", [
    { id: "source", ref: "surface:1", type: "terminal", url: null },
    { id: "existing", ref: "surface:2", type: "browser", url: `http://127.0.0.1:1/?instance=${INSTANCE_MARKER}` },
    { id: "owned-uuid", ref: "surface:3", type: "browser", url: launchUrl },
  ]);
  const churned = cmuxTree("w", [
    { id: "source", ref: "surface:1", type: "terminal", url: null },
    { id: "owned-uuid", ref: "surface:2", type: "browser", url: currentUrl },
  ]);
  const absent = cmuxTree("w", [{ id: "source", ref: "surface:1", type: "terminal", url: null }]);
  let treeCalls = 0;
  let closeRequested = false;
  const deps = launcherDeps({
    platform: "linux",
    socketExists: (socket) => socket === "/tmp/cmux.sock",
    run: (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (args.includes("tree")) {
        treeCalls++;
        if (treeCalls === 1) return { ok: true, stdout: before };
        if (treeCalls === 2) return { ok: true, stdout: after };
        return { ok: true, stdout: closeRequested ? absent : churned };
      }
      if (args[0] === "close-surface") closeRequested = true;
      return { ok: true, stdout: "undocumented new-pane output" };
    },
    open: () => {
      opened = true;
    },
    sleep: async () => undefined,
  });
  const env = { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET_PATH: "/tmp/cmux.sock" };
  const launch = await launchDashboard(launchUrl, "auto", env, "/repo", deps);
  assert.deepEqual(
    { kind: launch.kind, managed: launch.managed, surfaceId: launch.surfaceId },
    {
      kind: "cmux",
      managed: true,
      surfaceId: "owned-uuid",
    },
  );
  assert.equal(opened, false);
  assert.deepEqual(calls.slice(0, 4), [
    { command: "cmux", args: ["ping"], cwd: "/repo" },
    { command: "cmux", args: ["--id-format", "both", "tree", "--all", "--json"], cwd: "/repo" },
    {
      command: "cmux",
      args: [
        "new-pane",
        "--type",
        "browser",
        "--direction",
        "right",
        "--workspace",
        "w",
        "--url",
        launchUrl,
        "--focus",
        "false",
      ],
      cwd: "/repo",
    },
    { command: "cmux", args: ["--id-format", "both", "tree", "--all", "--json"], cwd: "/repo" },
  ]);
  assert.equal(await launch.focus(), true);
  await launch.close();
  await launch.close();
  assert.deepEqual(calls.slice(4), [
    { command: "cmux", args: ["--id-format", "both", "tree", "--all", "--json"], cwd: "/repo" },
    {
      command: "cmux",
      args: ["focus-panel", "--panel", "surface:2", "--workspace", "w"],
      cwd: "/repo",
    },
    {
      command: "cmux",
      args: ["browser", "--surface", "surface:2", "focus-webview"],
      cwd: "/repo",
    },
    { command: "cmux", args: ["--id-format", "both", "tree", "--all", "--json"], cwd: "/repo" },
    {
      command: "cmux",
      args: ["close-surface", "--surface", "surface:2", "--workspace", "w"],
      cwd: "/repo",
    },
    { command: "cmux", args: ["--id-format", "both", "tree", "--all", "--json"], cwd: "/repo" },
  ]);
  assert.equal(
    calls.some((call) => call.args.includes("source")),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        (call.args[0] === "focus-panel" || call.args[0] === "browser" || call.args[0] === "close-surface") &&
        call.args.includes("owned-uuid"),
    ),
    false,
  );
});

test("managed cmux handle refuses focus and close after exact surface URL mismatch", async () => {
  const url = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", []);
  const owned = cmuxTree("w", [{ id: "owned", ref: "surface:2", type: "browser", url }]);
  const reused = cmuxTree("w", [{ id: "owned", ref: "surface:2", type: "browser", url: "https://example.invalid/" }]);
  const snapshots = [before, owned, reused, reused];
  const calls: string[][] = [];
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      calls.push(args);
      return args.includes("tree") ? { ok: true, stdout: snapshots.shift()! } : { ok: true, stdout: "" };
    },
    open: () => undefined,
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "inherited", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );
  assert.equal(await launch.focus(), false);
  await launch.close();
  assert.equal(
    calls.some((args) => args[0] === "focus-panel" || args[0] === "close-surface"),
    false,
  );
  assert.equal(
    calls.some((args) => args.includes("inherited")),
    false,
  );
});

test("managed cmux focus accepts verified panel focus despite cmux 0.64.22 webview internal_error", async () => {
  const url = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", []);
  const owned = cmuxTree("w", [
    { id: "owned", ref: "surface:2", type: "browser", url: `http://127.0.0.1/?instance=${INSTANCE_MARKER}` },
  ]);
  let trees = 0;
  const calls: string[][] = [];
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      calls.push(args);
      if (args.includes("tree")) return { ok: true, stdout: trees++ === 0 ? before : owned };
      if (args[0] === "browser") return { ok: false, stdout: "" };
      return { ok: true, stdout: "" };
    },
    open: () => undefined,
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );

  assert.equal(await launch.focus(), true);
  assert.deepEqual(calls.slice(-2), [
    ["focus-panel", "--panel", "surface:2", "--workspace", "w"],
    ["browser", "--surface", "surface:2", "focus-webview"],
  ]);
});

test("async cmux focus deduplicates follower storms without starving a lease heartbeat", async () => {
  const url = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", []);
  const owned = cmuxTree("w", [{ id: "owned", ref: "surface:2", type: "browser", url }]);
  let startupTrees = 0;
  const asyncCalls: string[][] = [];
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      if (args.includes("tree")) return { ok: true, stdout: startupTrees++ === 0 ? before : owned };
      return { ok: true, stdout: "" };
    },
    runAsync: async (_command, args) => {
      asyncCalls.push(args);
      if (args.includes("tree")) return { ok: true, stdout: owned };
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { ok: false, stdout: "" };
    },
    open: () => undefined,
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );
  let leaseRenewals = 0;
  const heartbeat = setInterval(() => leaseRenewals++, 5);
  try {
    assert.deepEqual(await Promise.all([launch.focus(), launch.focus(), launch.focus()]), [false, false, false]);
  } finally {
    clearInterval(heartbeat);
  }

  assert.ok(leaseRenewals >= 2, `expected lease heartbeat to continue, got ${leaseRenewals} renewals`);
  assert.deepEqual(asyncCalls, [
    ["--id-format", "both", "tree", "--all", "--json"],
    ["focus-panel", "--panel", "surface:2", "--workspace", "w"],
  ]);
});

test("managed cmux close retries transient exact-tree and close failures before becoming idempotent", async () => {
  const url = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", []);
  const owned = cmuxTree("w", [{ id: "owned", ref: "surface:2", type: "browser", url }]);
  const absent = cmuxTree("w", []);
  const trees = [before, owned, null, owned, owned, owned, owned, absent];
  const sleeps: number[] = [];
  let closeCalls = 0;
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      if (args.includes("tree")) {
        const snapshot = trees.shift();
        return snapshot === null ? { ok: false, stdout: "" } : { ok: true, stdout: snapshot! };
      }
      if (args[0] === "close-surface") return { ok: ++closeCalls > 1, stdout: "" };
      return { ok: true, stdout: "" };
    },
    open: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );

  await Promise.all([launch.close(), launch.close()]);
  await launch.close();
  await launch.close();
  assert.equal(closeCalls, 3);
  assert.deepEqual(sleeps, [50, 50, 50, 50]);
  assert.equal(trees.length, 0);
});

test("ownership guard fences every API request and event stream, and close is idempotent", async () => {
  const store = await openStore(tmpDb());
  let owner = true;
  const server = await startDashboard({
    store,
    repoId: "r1",
    host: "127.0.0.1",
    port: 0,
    pollMs: 10,
    isOwner: () => owner,
  });
  try {
    const stream = await fetch(`${server.url}/api/events`, { headers: { authorization: auth(server) } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.equal((await reader.read()).done, false);
    owner = false;
    const fenced = await api(server, "/api/snapshot");
    assert.equal(fenced.response.status, 503);
    assert.equal(fenced.body.error, "ownership_lost");
    assert.equal((await reader.read()).done, true);
    await Promise.all([server.close(), server.close()]);
  } finally {
    await server.close();
    store.close();
  }
});

test("explicit cmux launcher falls back to the platform browser outside cmux context", async () => {
  let probes = 0;
  const opened: Array<{ command: string; args: string[]; cwd: string }> = [];
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => {
      probes++;
      return true;
    },
    run: () => {
      probes++;
      return { ok: false, stdout: "" };
    },
    open: (command, args, cwd) => opened.push({ command, args, cwd }),
    sleep: async () => undefined,
  });
  assert.equal((await launchDashboard("http://127.0.0.1/", "cmux", {}, "/repo", deps)).kind, "browser");
  assert.equal(probes, 0);
  assert.deepEqual(opened, [{ command: "open", args: ["http://127.0.0.1/"], cwd: "/repo" }]);
  assert.equal((await launchDashboard("http://127.0.0.1/", "browser", {}, "/repo", deps)).kind, "browser");
  assert.equal(probes, 0);
});

test("explicit cmux launcher falls back when its preflight probe fails before new-pane", async () => {
  const calls: string[][] = [];
  const opened: string[] = [];
  const deps = launcherDeps({
    platform: "linux",
    socketExists: () => true,
    run: (_command, args) => {
      calls.push(args);
      return { ok: false, stdout: "" };
    },
    open: (_command, args) => opened.push(...args),
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    `http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`,
    "cmux",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );
  assert.equal(launch.kind, "browser");
  assert.deepEqual(calls, [["ping"]]);
  assert.deepEqual(opened, [`http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`]);
});

test("explicit cmux launcher falls back when its preflight snapshot fails before new-pane", async () => {
  const calls: string[][] = [];
  const opened: string[] = [];
  const deps = launcherDeps({
    platform: "linux",
    socketExists: () => true,
    run: (_command, args) => {
      calls.push(args);
      return { ok: !args.includes("tree"), stdout: "" };
    },
    open: (_command, args) => opened.push(...args),
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    `http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`,
    "cmux",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );
  assert.equal(launch.kind, "browser");
  assert.deepEqual(calls, [["ping"], ["--id-format", "both", "tree", "--all", "--json"]]);
  assert.deepEqual(opened, [`http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`]);
});

test("launcher leaves an ambiguous attempted cmux launch unmanaged and does not open a second browser", async () => {
  const url = `http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", [{ id: "source", ref: "surface:1", type: "terminal", url: null }]);
  const after = cmuxTree("w", [
    { id: "source", ref: "surface:1", type: "terminal", url: null },
    { id: "new-a", ref: "surface:2", type: "browser", url },
    { id: "new-b", ref: "surface:3", type: "browser", url },
  ]);
  let trees = 0;
  let opens = 0;
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      if (args.includes("tree")) return { ok: true, stdout: trees++ === 0 ? before : after };
      return { ok: true, stdout: "" };
    },
    open: () => opens++,
    sleep: async () => undefined,
  });
  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );
  assert.deepEqual(
    { kind: launch.kind, managed: launch.managed, surfaceId: launch.surfaceId },
    {
      kind: "cmux",
      managed: false,
      surfaceId: null,
    },
  );
  await launch.close();
  assert.equal(opens, 0);
});

test("launcher polls for delayed cmux tree visibility without opening another browser", async () => {
  const url = `http://127.0.0.1:9000/?instance=${INSTANCE_MARKER}#cap=secret`;
  const before = cmuxTree("w", [{ id: "source", ref: "surface:1", type: "terminal", url: null }]);
  const after = cmuxTree("w", [
    { id: "source", ref: "surface:1", type: "terminal", url: null },
    { id: "owned", ref: "surface:2", type: "browser", url },
  ]);
  const treeSnapshots = [before, before, before, after];
  const sleeps: number[] = [];
  let trees = 0;
  let opens = 0;
  const deps = launcherDeps({
    platform: "darwin",
    socketExists: () => true,
    run: (_command, args) => {
      if (args.includes("tree")) return { ok: true, stdout: treeSnapshots[trees++]! };
      return { ok: true, stdout: "" };
    },
    open: () => opens++,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const launch = await launchDashboard(
    url,
    "auto",
    { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "source", CMUX_SOCKET: "/tmp/cmux.sock" },
    "/repo",
    deps,
  );

  assert.deepEqual({ managed: launch.managed, surfaceId: launch.surfaceId }, { managed: true, surfaceId: "owned" });
  assert.deepEqual(sleeps, [50, 50]);
  assert.equal(opens, 0);
});

test("cmux tree parsing scopes surfaces to the exact workspace and diff requires one matching addition", () => {
  const targetUrl = `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=secret`;
  const currentUrl = `http://127.0.0.1/?instance=${INSTANCE_MARKER}`;
  const raw = JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: "other",
            ref: "workspace:1",
            panes: [{ surfaces: [{ id: "x", ref: "surface:8", type: "browser", url: "u" }] }],
          },
          {
            id: "wanted",
            ref: "workspace:2",
            panes: [
              {
                surfaces: [
                  { id: "terminal", ref: "surface:9", type: "terminal", url: null },
                  { id: "old", ref: "surface:10", type: "browser", url: "old-url" },
                  { id: "new", ref: "surface:11", type: "browser", url: currentUrl },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const parsed = parseCmuxBrowserSurfaces(raw, "wanted");
  assert.deepEqual(parsed, [
    { id: "old", ref: "surface:10", url: "old-url", workspaceId: "wanted" },
    { id: "new", ref: "surface:11", url: currentUrl, workspaceId: "wanted" },
  ]);
  assert.equal(parseCmuxBrowserSurfaces("not json", "wanted"), null);
  assert.equal(parseCmuxBrowserSurfaces(raw, "missing"), null);
  const before: CmuxBrowserSurface[] = [{ id: "old", ref: "surface:10", url: "old-url", workspaceId: "wanted" }];
  assert.equal(findNewCmuxBrowserSurface(before, parsed!, targetUrl)?.id, "new");
  assert.equal(findNewCmuxBrowserSurface(before, [...parsed!, { ...parsed![1]!, id: "newer" }], targetUrl), null);
  assert.equal(findNewCmuxBrowserSurface(before, parsed!, targetUrl, "new"), null);

  assert.equal(matchesCmuxSurfaceUrlIdentity(targetUrl, targetUrl), true);
  assert.equal(matchesCmuxSurfaceUrlIdentity(currentUrl, targetUrl), true);
  assert.equal(matchesCmuxSurfaceUrlIdentity(`${currentUrl}#other`, targetUrl), true);
  assert.equal(matchesCmuxSurfaceUrlIdentity("http://127.0.0.1/", targetUrl), false);
  assert.equal(matchesCmuxSurfaceUrlIdentity("http://127.0.0.1/?instance=BBBBBBBBBBBBBBBBBBBBBB", targetUrl), false);
  assert.equal(matchesCmuxSurfaceUrlIdentity(`${currentUrl}&extra=value`, targetUrl), false);
});

test("dashboard flag parsers reject invalid values", () => {
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort("0"), 0);
  assert.equal(parsePort("65535"), 65535);
  assert.throws(() => parsePort("-1"), /between 0 and 65535/);
  assert.throws(() => parsePort("1.5"), /between 0 and 65535/);
  assert.throws(() => parsePort("65536"), /between 0 and 65535/);
  assert.equal(parseOpenMode(undefined), "auto");
  assert.equal(parseOpenMode("cmux"), "cmux");
  assert.throws(() => parseOpenMode("other"), /auto, browser, or cmux/);
});
