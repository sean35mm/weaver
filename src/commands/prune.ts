import {
  DEFAULT_ACTIVITY_MAX_AGE_DAYS,
  DEFAULT_ACTIVITY_MAX_EVENTS,
  DEFAULT_CLAIM_RETENTION_DAYS,
} from "../store/reap.ts";
import type { Store } from "../store/store.ts";

export function pruneAfterWrite(store: Store, now: number): void {
  store.pruneActivity({ maxEvents: DEFAULT_ACTIVITY_MAX_EVENTS, maxAgeDays: DEFAULT_ACTIVITY_MAX_AGE_DAYS, now });
  store.pruneClaims({ maxAgeDays: DEFAULT_CLAIM_RETENTION_DAYS, now });
}
