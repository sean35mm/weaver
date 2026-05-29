/** Open (and migrate) a store at a given path. */

import { openDb } from "./db.ts";
import { migrate } from "./schema.ts";
import { SqliteStore } from "./sqlite.ts";
import type { Store } from "./store.ts";

export async function openStore(dbPath: string): Promise<Store> {
  const db = await openDb(dbPath);
  migrate(db);
  return new SqliteStore(db);
}
