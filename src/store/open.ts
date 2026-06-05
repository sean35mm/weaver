/** Open (and migrate) a store at a given path. */

import { openDb } from "./db.ts";
import { migrate } from "./schema.ts";
import { SqliteStore } from "./sqlite.ts";
import type { Store } from "./store.ts";

export interface OpenStoreOptions {
  readOnly?: boolean;
  migrate?: boolean;
}

export async function openStore(dbPath: string, opts: OpenStoreOptions = {}): Promise<Store> {
  const db = await openDb(dbPath, { readOnly: opts.readOnly });
  if (opts.migrate ?? !opts.readOnly) migrate(db);
  return new SqliteStore(db);
}
