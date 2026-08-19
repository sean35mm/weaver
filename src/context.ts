/** The execution context handed to every command. */

import type { ParsedArgs } from "./args.ts";
import type { Config } from "./config.ts";
import type { Identity } from "./identity/session.ts";
import type { RepoIdentity } from "./repo/identity.ts";
import type { StoreHolderHandle } from "./store/coordination.ts";
import type { Store } from "./store/store.ts";

export interface Ctx {
  store: Store;
  /** Canonical effective Weaver home used by this invocation. */
  storeHome?: string;
  /** Canonical store path, even when the selected command does not create it. */
  storePath?: string;
  /** Exact external holder owned by this invocation; absent only for no-store commands/tests. */
  storeHolder?: StoreHolderHandle | null;
  /** Resolved session, or null when unresolved (observer commands tolerate null). */
  identity: Identity | null;
  /** Caller identity used for ownership matching even when too weak for revision attribution. */
  callerIdentity?: Identity | null;
  repo: RepoIdentity;
  config: Config;
  cwd: string;
  now: number;
  env: Record<string, string | undefined>;
  args: ParsedArgs;
  out(s: string): void;
  err(s: string): void;
}
