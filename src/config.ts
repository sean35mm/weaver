/** Tunable knobs, read from `weaver_meta` with sane defaults. Stored as seconds. */

import { DEFAULT_CLAIM_TTL_MS, DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_SESSION_TTL_MS } from "./store/reap.ts";
import type { Store } from "./store/store.ts";

export interface Config {
  sessionTtlMs: number;
  claimTtlMs: number;
  recentMs: number;
}

export const CONFIG_KEYS = ["session_ttl_seconds", "claim_ttl_seconds", "recent_activity_seconds"] as const;

function secondsOr(store: Store, key: string, fallbackMs: number): number {
  const raw = store.getMeta(key);
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallbackMs;
}

export function loadConfig(store: Store): Config {
  return {
    sessionTtlMs: secondsOr(store, "session_ttl_seconds", DEFAULT_SESSION_TTL_MS),
    claimTtlMs: secondsOr(store, "claim_ttl_seconds", DEFAULT_CLAIM_TTL_MS),
    recentMs: secondsOr(store, "recent_activity_seconds", DEFAULT_RECENT_ACTIVITY_MS),
  };
}
