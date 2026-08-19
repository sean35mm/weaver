import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardControlServer } from "../src/dashboard/control.ts";
import {
  coordinateDashboardOwnership,
  type DashboardLeaseStore,
  type DashboardOwner,
} from "../src/dashboard/ownership.ts";
import type { DashboardLeaseInput, DashboardLeaseRow } from "../src/store/store.ts";

const SCOPE = "scope";
const RUNTIME = "/private/runtime";
const INSTANCE_MARKER = "AAAAAAAAAAAAAAAAAAAAAA";

class MemoryLeaseStore implements DashboardLeaseStore {
  readonly leases = new Map<string, DashboardLeaseRow>();
  renewError: Error | undefined;

  getDashboardLease(scopeId: string): DashboardLeaseRow | undefined {
    const lease = this.leases.get(scopeId);
    return lease ? { ...lease } : undefined;
  }

  tryAcquireDashboardLease(input: DashboardLeaseInput): boolean {
    const lease = this.leases.get(input.scopeId);
    if (lease && lease.expiresAt > input.renewedAt) return false;
    this.leases.set(input.scopeId, { ...input });
    return true;
  }

  renewDashboardLease(input: DashboardLeaseInput): boolean {
    if (this.renewError) throw this.renewError;
    const lease = this.leases.get(input.scopeId);
    if (!lease || lease.ownerId !== input.ownerId || lease.expiresAt <= input.renewedAt) return false;
    this.leases.set(input.scopeId, { ...input });
    return true;
  }

  releaseDashboardLease(scopeId: string, ownerId: string): boolean {
    if (this.leases.get(scopeId)?.ownerId !== ownerId) return false;
    this.leases.delete(scopeId);
    return true;
  }
}

function fakeServer(onClose?: () => void): DashboardControlServer {
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      onClose?.();
    },
  };
}

function options(store: MemoryLeaseStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    repoId: "repo",
    scopeId: SCOPE,
    runtimeDirectory: RUNTIME,
    capability: "token",
    now: () => 100,
    startControlServer: async () => fakeServer(),
    ...overrides,
  };
}

test("same-scope concurrent election has one CAS winner and one exact ready follower", async () => {
  const store = new MemoryLeaseStore();
  let serverStarts = 0;
  const startControlServer = async (): Promise<DashboardControlServer> => {
    serverStarts++;
    return fakeServer();
  };
  const requestControl = async (input: { ownerId: string }) => ({
    protocol: 1 as const,
    repoId: "repo",
    ownerId: input.ownerId,
    state: "ready" as const,
    ok: true,
    launchUrl: `http://127.0.0.1:1234/?instance=${INSTANCE_MARKER}#cap=token`,
  });

  const [first, second] = await Promise.all([
    coordinateDashboardOwnership(options(store, { ownerId: "one", ownerPid: 1, startControlServer, requestControl })),
    coordinateDashboardOwnership(options(store, { ownerId: "two", ownerPid: 2, startControlServer, requestControl })),
  ]);

  assert.deepEqual([first.kind, second.kind].sort(), ["follower", "owner"]);
  assert.equal(serverStarts, 1);
  const owner = (first.kind === "owner" ? first : second) as DashboardOwner;
  await owner.close();
});

test("follower rejects ready control if the current lease expired during the request", async () => {
  const store = new MemoryLeaseStore();
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "old", ownerPid: 77, renewedAt: 0, expiresAt: 105 });
  let now = 100;
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        now: () => now,
        startupWaitMs: 6,
        followerPollMs: 1,
        sleep: async (ms: number) => {
          now += ms;
        },
        requestControl: async () => {
          now = Math.max(now, 105);
          return {
            protocol: 1,
            repoId: "repo",
            ownerId: "old",
            state: "ready",
            ok: true,
            launchUrl: `http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=token`,
          };
        },
        isProcessAlive: () => false,
      }),
    ),
    /ready/,
  );
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "old");
});

test("expired failed control takes over even when the recorded PID appears live or reused", async () => {
  const store = new MemoryLeaseStore();
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "old", ownerPid: process.pid, renewedAt: 0, expiresAt: 20 });
  let livenessChecks = 0;
  const result = await coordinateDashboardOwnership(
    options(store, {
      ownerId: "new",
      ownerPid: 88,
      now: () => 20,
      requestControl: async () => {
        throw new Error("stale socket");
      },
      isProcessAlive: () => {
        livenessChecks++;
        return true;
      },
    }),
  );
  assert.equal(result.kind, "owner");
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "new");
  assert.equal(livenessChecks, 0);
  if (result.kind === "owner") await result.close();
});

test("unexpired failed control does not permit takeover", async () => {
  const store = new MemoryLeaseStore();
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "old", ownerPid: 77, renewedAt: 10, expiresAt: 30 });
  let now = 20;
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        ownerId: "new",
        now: () => now,
        startupWaitMs: 5,
        followerPollMs: 5,
        sleep: async (ms: number) => {
          now += ms;
        },
        requestControl: async () => {
          throw new Error("control unavailable");
        },
      }),
    ),
    /control unavailable/,
  );
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "old");
});

test("takeover re-reads the exact expired lease after control failure", async () => {
  const store = new MemoryLeaseStore();
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "old", ownerPid: 77, renewedAt: 0, expiresAt: 20 });
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        ownerId: "new",
        now: () => 20,
        startupWaitMs: 0,
        requestControl: async () => {
          store.leases.set(SCOPE, {
            scopeId: SCOPE,
            ownerId: "other",
            ownerPid: 99,
            renewedAt: 0,
            expiresAt: 20,
          });
          throw new Error("old control unavailable");
        },
      }),
    ),
    /old control unavailable/,
  );
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "other");
});

test("responsive owner control prevents takeover even when the lease is expired", async () => {
  const store = new MemoryLeaseStore();
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "old", ownerPid: 77, renewedAt: 0, expiresAt: 20 });
  let livenessChecks = 0;
  let now = 20;
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        now: () => now,
        startupWaitMs: 10,
        followerPollMs: 10,
        sleep: async (ms: number) => {
          now += ms;
        },
        requestControl: async () => ({
          protocol: 1,
          repoId: "repo",
          ownerId: "old",
          state: "starting",
          ok: true,
        }),
        isProcessAlive: () => {
          livenessChecks++;
          return false;
        },
      }),
    ),
    /starting/,
  );
  assert.equal(livenessChecks, 0);
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "old");
});

test("a resumed expired owner is stopped by heartbeat and cannot release its successor", async () => {
  const store = new MemoryLeaseStore();
  let now = 0;
  let oldHeartbeat: (() => void) | undefined;
  const old = await coordinateDashboardOwnership(
    options(store, {
      ownerId: "old",
      ownerPid: 77,
      now: () => now,
      leaseTtlMs: 10,
      setInterval: (callback: () => void) => {
        oldHeartbeat = callback;
        return 1;
      },
      clearInterval: () => undefined,
    }),
  );
  assert.equal(old.kind, "owner");
  if (old.kind !== "owner") return;

  now = 10;
  const successor = await coordinateDashboardOwnership(
    options(store, {
      ownerId: "successor",
      ownerPid: 88,
      now: () => now,
      leaseTtlMs: 10,
      requestControl: async () => {
        throw new Error("old control unavailable");
      },
    }),
  );
  assert.equal(successor.kind, "owner");
  if (successor.kind !== "owner") return;

  oldHeartbeat?.();
  assert.equal((await old.stopped).reason, "ownership-lost");
  await old.close();
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "successor");
  await successor.close();
});

test("heartbeat starts before control startup and startup is fenced by renewal", async () => {
  const store = new MemoryLeaseStore();
  let heartbeatInstalled = false;
  let closeCount = 0;
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        setInterval: () => {
          heartbeatInstalled = true;
          return 1;
        },
        clearInterval: () => undefined,
        startControlServer: async () => {
          assert.equal(heartbeatInstalled, true);
          store.leases.set(SCOPE, {
            scopeId: SCOPE,
            ownerId: "successor",
            ownerPid: 9,
            renewedAt: 100,
            expiresAt: 200,
          });
          return fakeServer(() => closeCount++);
        },
      }),
    ),
    /lost during control startup/,
  );
  assert.equal(closeCount, 1);
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "successor");
});

test("control startup failure releases only the acquiring owner lease", async () => {
  const store = new MemoryLeaseStore();
  await assert.rejects(
    coordinateDashboardOwnership(
      options(store, {
        ownerId: "owner",
        startControlServer: async () => {
          throw new Error("listen failed");
        },
      }),
    ),
    /listen failed/,
  );
  assert.equal(store.getDashboardLease(SCOPE), undefined);
});

test("ready renews immediately before publishing and surfaces ownership loss", async () => {
  const store = new MemoryLeaseStore();
  let closed = 0;
  const result = await coordinateDashboardOwnership(
    options(store, { ownerId: "owner", startControlServer: async () => fakeServer(() => closed++) }),
  );
  assert.equal(result.kind, "owner");
  if (result.kind !== "owner") return;
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "successor", ownerPid: 9, renewedAt: 100, expiresAt: 200 });

  await assert.rejects(
    result.ready(`http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=token`),
    /lost before readiness/,
  );
  const stopped = await result.stopped;
  assert.equal(stopped.reason, "ownership-lost");
  assert.equal(result.getState(), "shutting-down");
  assert.equal(closed, 1);
});

test("renewal exception triggers stopped signal, callback, and socket close", async () => {
  const store = new MemoryLeaseStore();
  let heartbeat: (() => void) | undefined;
  let callbackError: Error | undefined;
  let closed = 0;
  const result = await coordinateDashboardOwnership(
    options(store, {
      ownerId: "owner",
      setInterval: (callback: () => void) => {
        heartbeat = callback;
        return 1;
      },
      clearInterval: () => undefined,
      startControlServer: async () => fakeServer(() => closed++),
      onOwnershipLost: (error: Error) => {
        callbackError = error;
      },
    }),
  );
  assert.equal(result.kind, "owner");
  if (result.kind !== "owner") return;
  await result.ready(`http://127.0.0.1/?instance=${INSTANCE_MARKER}#cap=token`);
  store.renewError = new Error("db unavailable");
  heartbeat?.();

  const stopped = await result.stopped;
  assert.equal(stopped.reason, "ownership-lost");
  if (stopped.reason === "ownership-lost") assert.equal(stopped.error.message, "db unavailable");
  assert.equal(callbackError?.message, "db unavailable");
  assert.equal(closed, 1);
});

test("shutdown signals promptly but heartbeat continues until idempotent close", async () => {
  const store = new MemoryLeaseStore();
  let heartbeat: (() => void) | undefined;
  let requestStop: (() => void | Promise<void>) | undefined;
  let clears = 0;
  const result = await coordinateDashboardOwnership(
    options(store, {
      ownerId: "owner",
      setInterval: (callback: () => void) => {
        heartbeat = callback;
        return 1;
      },
      clearInterval: () => clears++,
      startControlServer: async (serverOptions: { requestStop?: () => void | Promise<void> }) => {
        requestStop = serverOptions.requestStop;
        return fakeServer();
      },
    }),
  );
  assert.equal(result.kind, "owner");
  if (result.kind !== "owner") return;
  const before = store.getDashboardLease(SCOPE)?.renewedAt;
  requestStop?.();
  assert.deepEqual(await result.stopped, { reason: "shutdown-requested" });
  assert.equal(result.getState(), "shutting-down");
  heartbeat?.();
  assert.equal(store.getDashboardLease(SCOPE)?.renewedAt, before);
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "owner");

  await Promise.all([result.close(), result.close()]);
  assert.equal(store.getDashboardLease(SCOPE), undefined);
  assert.equal(clears, 1);
});

test("stale owner close releases only exact scope and owner", async () => {
  const store = new MemoryLeaseStore();
  const result = await coordinateDashboardOwnership(options(store, { ownerId: "old" }));
  assert.equal(result.kind, "owner");
  if (result.kind !== "owner") return;
  store.leases.set(SCOPE, { scopeId: SCOPE, ownerId: "successor", ownerPid: 9, renewedAt: 100, expiresAt: 200 });
  store.leases.set("other", { scopeId: "other", ownerId: "old", ownerPid: 8, renewedAt: 100, expiresAt: 200 });

  await Promise.all([result.close(), result.close()]);
  assert.equal(store.getDashboardLease(SCOPE)?.ownerId, "successor");
  assert.equal(store.getDashboardLease("other")?.ownerId, "old");
});
