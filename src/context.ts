/** The execution context handed to every command. */

import type { ParsedArgs } from "./args.ts";
import type { Config } from "./config.ts";
import type { Identity } from "./identity/session.ts";
import type { RepoIdentity } from "./repo/identity.ts";
import type { Store } from "./store/store.ts";

export interface Ctx {
  store: Store;
  /** Resolved session, or null when unresolved (observer commands tolerate null). */
  identity: Identity | null;
  repo: RepoIdentity;
  config: Config;
  cwd: string;
  now: number;
  env: Record<string, string | undefined>;
  args: ParsedArgs;
  out(s: string): void;
  err(s: string): void;
}
