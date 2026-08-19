import { DEFAULT_SESSION_TTL_MS } from "../store/reap.ts";
import type {
  ScratchpadActorKind,
  ScratchpadAttachmentRow,
  ScratchpadRevisionInput,
  ScratchpadRevisionRow,
  ScratchpadRow,
  ScratchpadState,
  Store,
} from "../store/store.ts";

export const MAX_SCRATCHPAD_TITLE_CHARS = 200;
export const MAX_SCRATCHPAD_BODY_BYTES = 1_000_000;

export interface ScratchpadActor {
  kind: ScratchpadActorKind;
  sessionId: string | null;
  harness: string | null;
  provenance: string;
  worktreeId: string | null;
}

export interface ScratchpadCaller {
  sessionId: string;
  worktreeId: string;
}

export class ScratchpadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScratchpadError";
  }
}

export class ScratchpadConflictError extends ScratchpadError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`stale scratchpad revision: expected ${expectedRevision}, current is ${actualRevision}`);
    this.name = "ScratchpadConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function canonicalBody(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized.includes("\0")) throw new ScratchpadError("scratchpad body cannot contain NUL bytes");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > MAX_SCRATCHPAD_BODY_BYTES) {
    throw new ScratchpadError(
      `scratchpad body is ${bytes} bytes; limit is ${MAX_SCRATCHPAD_BODY_BYTES} bytes (content was not truncated)`,
    );
  }
  return normalized;
}

function canonicalTitle(title: string): string {
  if (title.includes("\0") || title.includes("\n") || title.includes("\r"))
    throw new ScratchpadError("scratchpad title must be one line without NUL bytes");
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) throw new ScratchpadError("scratchpad title cannot be empty");
  if (normalized.length > MAX_SCRATCHPAD_TITLE_CHARS) {
    throw new ScratchpadError(
      `scratchpad title is ${normalized.length} characters; limit is ${MAX_SCRATCHPAD_TITLE_CHARS} (title was not truncated)`,
    );
  }
  return normalized;
}

export interface MarkdownHeading {
  line: number;
  level: number;
  text: string;
  raw: string;
}

/** Scan ATX headings while ignoring content inside backtick and tilde fenced code blocks. */
export function scanMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const [line, raw] of markdown.split("\n").entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(raw)) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(raw);
    if (match) headings.push({ line, level: match[1]!.length, text: match[2]!.trim(), raw });
  }
  return headings;
}

/** Replace only the body beneath a Markdown ATX heading, through the next peer/parent heading. */
export function replaceMarkdownSection(markdown: string, heading: string, replacement: string): string {
  const wanted = heading
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .toLowerCase();
  if (!wanted) throw new ScratchpadError("section heading cannot be empty");
  const lines = markdown.split("\n");
  const scanned = scanMarkdownHeadings(markdown);
  const headingIndex = scanned.findIndex((entry) => entry.text.toLowerCase() === wanted);
  if (headingIndex < 0) throw new ScratchpadError(`section heading not found: ${heading}`);
  const found = scanned[headingIndex]!;
  const start = found.line;
  const end = scanned.slice(headingIndex + 1).find((entry) => entry.level <= found.level)?.line ?? lines.length;
  const body = canonicalBody(replacement);
  const replacementLines = body.length ? body.split("\n") : [];
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return [...before, ...replacementLines, ...after].join("\n");
}

interface MutateOptions {
  id: number;
  expectedRevision: number;
  actor: ScratchpadActor;
  action: string;
  reason?: string | null;
  requireActive?: boolean;
  change(current: ScratchpadRow): Pick<ScratchpadRow, "title" | "body" | "state" | "previousState">;
}

export class ScratchpadService {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;

  constructor(store: Store, now: () => number, sessionTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.store = store;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
  }

  create(title: string, body: string, actor: ScratchpadActor): ScratchpadRow {
    const checkedTitle = canonicalTitle(title);
    const checkedBody = canonicalBody(body);
    return this.store.transaction(() => {
      const timestamp = this.now();
      const created = this.store.createScratchpad({ title: checkedTitle, body: checkedBody, createdAt: timestamp });
      this.appendRevision(created, actor, "create", null, timestamp);
      this.recordActivity(created, actor, "create", timestamp);
      return created;
    });
  }

  replace(id: number, body: string, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const checked = canonicalBody(body);
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "replace",
      requireActive: true,
      change: (current) => ({ ...current, body: checked }),
    });
  }

  update(id: number, title: string, body: string, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const checkedTitle = canonicalTitle(title);
    const checkedBody = canonicalBody(body);
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "update",
      requireActive: true,
      change: (current) => ({ ...current, title: checkedTitle, body: checkedBody }),
    });
  }

  updateIfChanged(
    id: number,
    title: string,
    body: string,
    expectedRevision: number,
    actor: ScratchpadActor,
  ): ScratchpadRow {
    const checkedTitle = canonicalTitle(title);
    const checkedBody = canonicalBody(body);
    return this.store.transaction(() => {
      const current = this.requireExpected(id, expectedRevision);
      if (current.state !== "active")
        throw new ScratchpadError(`scratchpad #${current.id} is ${current.state} and cannot be edited`);
      if (current.title === checkedTitle && current.body === checkedBody) return current;
      return this.applyMutation(current, actor, "update", null, { ...current, title: checkedTitle, body: checkedBody });
    });
  }

  append(id: number, body: string, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const checked = canonicalBody(body);
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "append",
      requireActive: true,
      change: (current) => ({
        ...current,
        body: canonicalBody(
          current.body && checked && !current.body.endsWith("\n") && !checked.startsWith("\n")
            ? `${current.body}\n${checked}`
            : current.body + checked,
        ),
      }),
    });
  }

  editSection(
    id: number,
    heading: string,
    body: string,
    expectedRevision: number,
    actor: ScratchpadActor,
  ): ScratchpadRow {
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "edit-section",
      requireActive: true,
      change: (current) => ({ ...current, body: canonicalBody(replaceMarkdownSection(current.body, heading, body)) }),
    });
  }

  rename(id: number, title: string, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const checked = canonicalTitle(title);
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "rename",
      requireActive: true,
      change: (current) => ({ ...current, title: checked }),
    });
  }

  archive(
    id: number,
    expectedRevision: number,
    actor: ScratchpadActor,
    caller: ScratchpadCaller | null,
  ): ScratchpadRow {
    return this.lifecycle(id, expectedRevision, actor, caller, "archive", "archived", null);
  }

  restore(id: number, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const current = this.requirePad(id);
    if (current.state !== "archived") throw new ScratchpadError(`scratchpad #${id} is not archived`);
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "restore",
      change: (pad) => ({ ...pad, state: "active", previousState: pad.state }),
    });
  }

  trash(
    id: number,
    expectedRevision: number,
    actor: ScratchpadActor,
    caller: ScratchpadCaller | null,
    reason: string | null,
  ): ScratchpadRow {
    if (actor.kind === "agent" && !reason?.trim()) throw new ScratchpadError("agent trash requires --reason");
    return this.lifecycle(id, expectedRevision, actor, caller, "trash", "trash", reason?.trim() || null);
  }

  recover(id: number, expectedRevision: number, actor: ScratchpadActor): ScratchpadRow {
    const current = this.requirePad(id);
    if (current.state !== "trash") throw new ScratchpadError(`scratchpad #${id} is not in trash`);
    const recovered: ScratchpadState =
      current.previousState === "active" || current.previousState === "archived" ? current.previousState : "active";
    return this.mutate({
      id,
      expectedRevision,
      actor,
      action: "recover",
      change: (pad) => ({ ...pad, state: recovered, previousState: pad.state }),
    });
  }

  use(id: number, caller: ScratchpadCaller): ScratchpadAttachmentRow {
    return this.store.transaction(() => {
      const pad = this.requirePad(id);
      if (pad.state !== "active") throw new ScratchpadError(`scratchpad #${id} is ${pad.state} and cannot be attached`);
      const existing = this.store.getScratchpadAttachment(caller.sessionId, caller.worktreeId);
      if (existing?.scratchpadId === id) return existing;
      const timestamp = this.now();
      this.store.detachScratchpad(caller.sessionId, caller.worktreeId, timestamp);
      const attachmentId = this.store.attachScratchpad({
        scratchpadId: id,
        sessionId: caller.sessionId,
        worktreeId: caller.worktreeId,
        attachedAt: timestamp,
      });
      return (
        this.store.getScratchpadAttachment(caller.sessionId, caller.worktreeId) ?? {
          id: attachmentId,
          scratchpadId: id,
          sessionId: caller.sessionId,
          worktreeId: caller.worktreeId,
          attachedAt: timestamp,
          detachedAt: null,
        }
      );
    });
  }

  list(states: ScratchpadState[] | null = ["active"], limit = 50): ScratchpadRow[] {
    return this.store.listScratchpads(states, limit);
  }

  find(query: string, states: ScratchpadState[] | null = ["active"], limit = 50): ScratchpadRow[] {
    return this.store.findScratchpads(query, states, limit);
  }

  get(id: number): ScratchpadRow {
    return this.requirePad(id);
  }

  history(id: number, limit = 100): ScratchpadRevisionRow[] {
    this.requirePad(id);
    return this.store.listScratchpadRevisions(id, limit);
  }

  private lifecycle(
    id: number,
    expectedRevision: number,
    actor: ScratchpadActor,
    caller: ScratchpadCaller | null,
    action: "archive" | "trash",
    state: "archived" | "trash",
    reason: string | null,
  ): ScratchpadRow {
    return this.store.transaction(() => {
      const current = this.requireExpected(id, expectedRevision);
      if (action === "archive" && current.state !== "active")
        throw new ScratchpadError(`scratchpad #${id} is ${current.state}, not active`);
      if (action === "trash" && current.state === "trash")
        throw new ScratchpadError(`scratchpad #${id} is already in trash`);
      const attachments = this.store.listScratchpadAttachments(id);
      const timestamp = this.now();
      const isCaller = (entry: ScratchpadAttachmentRow): boolean =>
        Boolean(caller && entry.sessionId === caller.sessionId && entry.worktreeId === caller.worktreeId);
      const isLive = (entry: ScratchpadAttachmentRow): boolean => {
        const session = this.store.getSession(entry.sessionId);
        return Boolean(
          session &&
            session.endedAt === null &&
            session.lastSeen >= timestamp - this.sessionTtlMs &&
            (session.worktreeId === null || session.worktreeId === entry.worktreeId),
        );
      };
      const others = attachments.filter((entry) => !isCaller(entry) && isLive(entry));
      if (others.length) {
        throw new ScratchpadError(
          `scratchpad #${id} has ${others.length} other live attachment${others.length === 1 ? "" : "s"}; ask those sessions to use another pad or run done`,
        );
      }
      for (const attachment of attachments) {
        if (isCaller(attachment) || !isLive(attachment)) {
          this.store.detachScratchpad(attachment.sessionId, attachment.worktreeId, timestamp);
        }
      }
      return this.applyMutation(
        current,
        actor,
        action,
        reason,
        {
          ...current,
          state,
          previousState: current.state,
        },
        timestamp,
      );
    });
  }

  private mutate(opts: MutateOptions): ScratchpadRow {
    return this.store.transaction(() => {
      const current = this.requireExpected(opts.id, opts.expectedRevision);
      if (opts.requireActive && current.state !== "active")
        throw new ScratchpadError(`scratchpad #${current.id} is ${current.state} and cannot be edited`);
      return this.applyMutation(current, opts.actor, opts.action, opts.reason ?? null, opts.change(current));
    });
  }

  private applyMutation(
    current: ScratchpadRow,
    actor: ScratchpadActor,
    action: string,
    reason: string | null,
    changed: Pick<ScratchpadRow, "title" | "body" | "state" | "previousState">,
    timestamp = this.now(),
  ): ScratchpadRow {
    const updated = this.store.updateScratchpad({
      id: current.id,
      expectedRevision: current.revision,
      title: canonicalTitle(changed.title),
      body: canonicalBody(changed.body),
      state: changed.state,
      previousState: changed.previousState,
      updatedAt: timestamp,
    });
    if (!updated) {
      const actual = this.store.getScratchpad(current.id)?.revision ?? current.revision;
      throw new ScratchpadConflictError(current.revision, actual);
    }
    const result = this.requirePad(current.id);
    this.appendRevision(result, actor, action, reason, timestamp);
    this.recordActivity(result, actor, action, timestamp);
    return result;
  }

  private appendRevision(
    pad: ScratchpadRow,
    actor: ScratchpadActor,
    action: string,
    reason: string | null,
    timestamp: number,
  ): void {
    const revision: ScratchpadRevisionInput = {
      scratchpadId: pad.id,
      revision: pad.revision,
      title: pad.title,
      body: pad.body,
      state: pad.state,
      previousState: pad.previousState,
      createdAt: timestamp,
      actorKind: actor.kind,
      actorId: actor.sessionId,
      actorHarness: actor.harness,
      worktreeId: actor.worktreeId,
      provenance: actor.provenance,
      action,
      reason,
    };
    this.store.addScratchpadRevision(revision);
  }

  private recordActivity(pad: ScratchpadRow, actor: ScratchpadActor, action: string, timestamp: number): void {
    if (!actor.sessionId) return;
    this.store.addActivity({
      sessionId: actor.sessionId,
      ts: timestamp,
      kind: "scratchpad",
      target: null,
      summary: `${action} #${pad.id} ${pad.title}`,
      meta: JSON.stringify({ scratchpadId: pad.id, revision: pad.revision, action }),
      worktreeId: actor.worktreeId,
      scratchpadId: pad.id,
    });
  }

  private requirePad(id: number): ScratchpadRow {
    const pad = this.store.getScratchpad(id);
    if (!pad) throw new ScratchpadError(`scratchpad #${id} not found`);
    return pad;
  }

  private requireExpected(id: number, expectedRevision: number): ScratchpadRow {
    const pad = this.requirePad(id);
    if (pad.revision !== expectedRevision) throw new ScratchpadConflictError(expectedRevision, pad.revision);
    return pad;
  }
}
