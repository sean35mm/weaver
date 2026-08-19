import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flagBool, flagStr, type ParsedArgs, rest } from "../args.ts";
import type { Ctx } from "../context.ts";
import {
  MAX_SCRATCHPAD_BODY_BYTES,
  type ScratchpadActor,
  type ScratchpadCaller,
  ScratchpadConflictError,
  ScratchpadError,
  ScratchpadService,
  scanMarkdownHeadings,
} from "../scratchpads/service.ts";
import type { ScratchpadRevisionRow, ScratchpadRow, ScratchpadState } from "../store/store.ts";
import { CliError, requireArg, requireBoundedInteger, requireIdentity, requirePositiveInteger } from "../validate.ts";

export type ScratchpadPresence = "observer" | "optional" | "required";

export interface ScratchpadCommandTraits {
  store: "none" | "touch" | "create";
  presence: ScratchpadPresence;
  writeGated: boolean;
  usage: boolean;
}

const OBSERVER_SUBCOMMANDS = new Set(["list", "read", "find", "history"]);
const MUTATING_SUBCOMMANDS = new Set([
  "create",
  "use",
  "replace",
  "append",
  "edit-section",
  "rename",
  "edit",
  "archive",
  "restore",
  "trash",
  "recover",
]);

export function commandTraits(args: ParsedArgs): ScratchpadCommandTraits {
  const subcommand = args._[1] ?? "list";
  if (subcommand === "help") {
    return { store: "none", presence: "observer", writeGated: false, usage: false };
  }
  if (OBSERVER_SUBCOMMANDS.has(subcommand)) {
    return { store: "touch", presence: "observer", writeGated: false, usage: true };
  }
  if (MUTATING_SUBCOMMANDS.has(subcommand)) {
    return {
      store: "create",
      presence: subcommand === "use" ? "required" : "optional",
      writeGated: true,
      usage: false,
    };
  }
  // Unknown/help paths should not create state or presence just to print usage.
  return { store: "none", presence: "observer", writeGated: false, usage: false };
}

function usage(ctx: Ctx): void {
  ctx.out("scratchpad commands:\n");
  ctx.out("  scratchpad list [--state active|archived|trash|all] [--limit N] [--json]\n");
  ctx.out("  scratchpad create <title> [--from FILE|-] [--json]\n");
  ctx.out("  scratchpad read <id> [--headings|--section HEADING|--tail N|--full] [--json]\n");
  ctx.out("  scratchpad find <query…> [--state …] [--limit N] [--json]\n");
  ctx.out("  scratchpad use <id>\n");
  ctx.out("  scratchpad replace|append <id> [--from FILE|-] [--revision N]\n");
  ctx.out("  scratchpad edit-section <id> <heading> [--from FILE|-] [--revision N]\n");
  ctx.out("  scratchpad rename <id> <title…> [--revision N]\n");
  ctx.out("  scratchpad edit <id> [--revision N]  # $VISUAL/$EDITOR\n");
  ctx.out("  scratchpad history <id> [--limit N] [--full] [--json]\n");
  ctx.out("  scratchpad archive|restore|recover <id> [--revision N]\n");
  ctx.out("  scratchpad trash <id> --reason WHY --revision N\n");
}

function padId(raw: string | undefined): number {
  return requirePositiveInteger(raw, "scratchpad id");
}

function actor(ctx: Ctx, provenance = "cli"): ScratchpadActor {
  return ctx.identity
    ? {
        kind: "agent",
        sessionId: ctx.identity.key,
        harness: ctx.identity.label,
        provenance,
        worktreeId: ctx.repo.worktreeId ?? null,
      }
    : { kind: "human", sessionId: null, harness: null, provenance, worktreeId: ctx.repo.worktreeId ?? null };
}

function caller(ctx: Ctx): ScratchpadCaller | null {
  const identity = ctx.callerIdentity ?? ctx.identity;
  return identity && ctx.repo.worktreeId ? { sessionId: identity.key, worktreeId: ctx.repo.worktreeId } : null;
}

function service(ctx: Ctx, now: () => number = () => ctx.now): ScratchpadService {
  return new ScratchpadService(ctx.store, now, ctx.config.sessionTtlMs);
}

function expectedRevision(ctx: Ctx, pad: ScratchpadRow): number {
  const raw = flagStr(ctx.args, "revision") ?? flagStr(ctx.args, "expected-revision") ?? flagStr(ctx.args, "expected");
  if (raw === undefined) {
    if (ctx.identity) throw new CliError("agent scratchpad mutation requires --revision <current-revision>");
    return pad.revision;
  }
  return requirePositiveInteger(raw, "--revision");
}

function resultLimit(ctx: Ctx, normal: number, full: number): number {
  const raw = flagStr(ctx.args, "limit");
  return raw === undefined
    ? flagBool(ctx.args, "full")
      ? full
      : normal
    : requireBoundedInteger(raw, "--limit", 1, full);
}

function bodyCommandRest(ctx: Ctx, from: number): string {
  const values = ctx.args._.slice(from);
  if (ctx.args.flags.from === true && values.at(-1) === "-") values.pop();
  return values.join(" ").trim();
}

function decodeMarkdown(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new CliError(`${source} is not valid UTF-8 Markdown`);
  }
}

async function stdinBody(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_SCRATCHPAD_BODY_BYTES) {
      throw new CliError(
        `scratchpad body exceeds ${MAX_SCRATCHPAD_BODY_BYTES} bytes (input was not truncated or written)`,
      );
    }
    chunks.push(buffer);
  }
  return decodeMarkdown(Buffer.concat(chunks), "stdin");
}

async function bodyInput(ctx: Ctx): Promise<string> {
  // The generic argv parser sees the conventional `--from -` spelling as a boolean flag.
  const from = ctx.args.flags.from === true ? "-" : flagStr(ctx.args, "from");
  if (from && from !== "-") {
    try {
      const filename = path.resolve(ctx.cwd, from);
      const stat = fs.statSync(filename);
      if (stat.size > MAX_SCRATCHPAD_BODY_BYTES) {
        throw new CliError(
          `scratchpad body file is ${stat.size} bytes; limit is ${MAX_SCRATCHPAD_BODY_BYTES} (content was not truncated)`,
        );
      }
      const contents = fs.readFileSync(filename);
      if (contents.length > MAX_SCRATCHPAD_BODY_BYTES) {
        throw new CliError(
          `scratchpad body file is ${contents.length} bytes; limit is ${MAX_SCRATCHPAD_BODY_BYTES} (content was not truncated)`,
        );
      }
      return decodeMarkdown(contents, `--from ${JSON.stringify(from)}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`cannot read --from ${JSON.stringify(from)}: ${(error as Error).message}`);
    }
  }
  if (from === "-" || !process.stdin.isTTY) return stdinBody();
  throw new CliError("body required: pass --from <file>, --from -, or pipe Markdown on stdin");
}

function states(ctx: Ctx): ScratchpadState[] | null {
  if (flagBool(ctx.args, "all")) return null;
  const value = (flagStr(ctx.args, "state") ?? "active").toLowerCase();
  if (value === "all") return null;
  if (value !== "active" && value !== "archived" && value !== "trash")
    throw new CliError("--state expects active, archived, trash, or all");
  return [value];
}

function padSummary(pad: ScratchpadRow, attachments: number) {
  return {
    id: pad.id,
    title: pad.title,
    state: pad.state,
    previousState: pad.previousState,
    revision: pad.revision,
    createdAt: pad.createdAt,
    updatedAt: pad.updatedAt,
    attachments,
  };
}

function writeList(ctx: Ctx, pads: ScratchpadRow[]): void {
  const rows = pads.map((pad) => padSummary(pad, ctx.store.listScratchpadAttachments(pad.id).length));
  if (flagBool(ctx.args, "json")) {
    ctx.out(`${JSON.stringify(rows)}\n`);
    return;
  }
  if (!rows.length) {
    ctx.out("no scratchpads\n");
    return;
  }
  for (const row of rows) {
    ctx.out(
      `#${row.id} ${row.title}  [${row.state}] r${row.revision}${row.attachments ? ` · ${row.attachments} attached` : ""}\n`,
    );
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  let result = text;
  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    const bytes = Buffer.byteLength(result, "utf8");
    result = result.slice(0, Math.max(0, Math.floor((result.length * maxBytes) / bytes) - 1));
  }
  if (/^[\uD800-\uDBFF]$/.test(result.at(-1) ?? "")) result = result.slice(0, -1);
  return result;
}

function utf8Suffix(text: string, maxBytes: number): string {
  let result = text;
  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    const bytes = Buffer.byteLength(result, "utf8");
    result = result.slice(Math.min(result.length, Math.ceil((result.length * (bytes - maxBytes)) / bytes) + 1));
  }
  if (/^[\uDC00-\uDFFF]$/.test(result[0] ?? "")) result = result.slice(1);
  return result;
}

function headings(markdown: string, limit = 200, maxBytes = 50_000): { text: string; truncated: boolean } {
  const found: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const heading of scanMarkdownHeadings(markdown)) {
    const line = heading.raw;
    const nextBytes = Buffer.byteLength(line, "utf8") + (found.length ? 1 : 0);
    if (found.length >= limit || bytes + nextBytes > maxBytes) {
      truncated = true;
      break;
    }
    found.push(line);
    bytes += nextBytes;
  }
  return { text: found.join("\n"), truncated };
}

function section(
  markdown: string,
  wanted: string,
  maxLines = 300,
  maxBytes = 50_000,
): { text: string; truncated: boolean } {
  const query = wanted
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .toLowerCase();
  const lines = markdown.split("\n");
  const scanned = scanMarkdownHeadings(markdown);
  const headingIndex = scanned.findIndex((entry) => entry.text.toLowerCase() === query);
  if (headingIndex < 0) throw new CliError(`section heading not found: ${wanted}`);
  const heading = scanned[headingIndex]!;
  const start = heading.line;
  const end = scanned.slice(headingIndex + 1).find((entry) => entry.level <= heading.level)?.line ?? lines.length;
  const selected = lines.slice(start, Math.min(end, start + maxLines));
  let text = selected.join("\n");
  const truncated = end - start > maxLines || Buffer.byteLength(text, "utf8") > maxBytes;
  text = utf8Prefix(text, maxBytes);
  return { text, truncated };
}

function readContent(
  ctx: Ctx,
  pad: ScratchpadRow,
): { content: string; mode: string; truncated: boolean; guidance?: string } {
  if (flagBool(ctx.args, "headings")) {
    const result = headings(pad.body);
    return { content: result.text, mode: "headings", truncated: result.truncated };
  }
  const sectionName = flagStr(ctx.args, "section");
  if (sectionName) {
    const result = section(pad.body, sectionName);
    return { content: result.text, mode: "section", truncated: result.truncated };
  }
  const tailRaw = flagStr(ctx.args, "tail");
  if (tailRaw !== undefined) {
    const count = requireBoundedInteger(tailRaw, "--tail", 1, 500);
    const lines = pad.body.split("\n");
    const selected = lines.slice(-count).join("\n");
    return {
      content: utf8Suffix(selected, 50_000),
      mode: "tail",
      truncated: lines.length > count || Buffer.byteLength(selected, "utf8") > 50_000,
    };
  }
  if (
    flagBool(ctx.args, "full") ||
    (Buffer.byteLength(pad.body, "utf8") <= 50_000 && pad.body.split("\n").length <= 500)
  ) {
    return { content: pad.body, mode: "full", truncated: false };
  }
  const outline = headings(pad.body);
  return {
    content: outline.text,
    mode: "headings",
    truncated: true,
    guidance: `large scratchpad (${Buffer.byteLength(pad.body, "utf8")} bytes); use --section <heading>, --tail N, or --full`,
  };
}

function writePad(ctx: Ctx, pad: ScratchpadRow): void {
  const result = readContent(ctx, pad);
  if (flagBool(ctx.args, "json")) {
    ctx.out(
      `${JSON.stringify({ ...padSummary(pad, ctx.store.listScratchpadAttachments(pad.id).length), ...result })}\n`,
    );
    return;
  }
  ctx.out(`#${pad.id} ${pad.title}  [${pad.state}] r${pad.revision}\n`);
  if (result.guidance) ctx.out(`${result.guidance}\n`);
  if (result.content) ctx.out(`${result.content}${result.content.endsWith("\n") ? "" : "\n"}`);
  if (result.truncated && !result.guidance) ctx.out("… bounded output; use --full for complete Markdown\n");
}

function revisionJson(revision: ScratchpadRevisionRow, full: boolean): Record<string, unknown> {
  return {
    revision: revision.revision,
    title: revision.title,
    state: revision.state,
    previousState: revision.previousState,
    createdAt: revision.createdAt,
    actor: { kind: revision.actorKind, id: revision.actorId, harness: revision.actorHarness },
    worktreeId: revision.worktreeId,
    provenance: revision.provenance,
    action: revision.action,
    reason: revision.reason,
    ...(full ? { body: revision.body } : {}),
  };
}

function splitEditorArgv(value: string): string[] {
  const parts: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (token) {
        parts.push(token);
        token = "";
      }
    } else token += char;
  }
  if (escaped || quote) throw new CliError("$VISUAL/$EDITOR contains an unmatched quote or escape");
  if (token) parts.push(token);
  return parts;
}

function removeDraft(directory: string, filename: string): void {
  try {
    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  } catch {
    // Best effort; the edit already succeeded.
  }
}

function runEditor(ctx: Ctx, pad: ScratchpadRow): number {
  const editorValue = ctx.env.VISUAL?.trim() || ctx.env.EDITOR?.trim();
  if (!editorValue) throw new CliError("no editor configured; set $VISUAL or $EDITOR");
  const argv = splitEditorArgv(editorValue);
  if (!argv.length) throw new CliError("$VISUAL/$EDITOR is empty");
  const revision = expectedRevision(ctx, pad);
  if (revision !== pad.revision) throw new ScratchpadConflictError(revision, pad.revision);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weaver-scratchpad-"));
  const filename = path.join(directory, `scratchpad-${pad.id}.md`);
  fs.writeFileSync(filename, pad.body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(filename, 0o600);
  const result = spawnSync(argv[0]!, [...argv.slice(1), filename], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new CliError(
      `editor failed; draft preserved at ${filename}${result.error ? `: ${result.error.message}` : ""}`,
    );
  }
  const editedBuffer = fs.readFileSync(filename);
  if (editedBuffer.length > MAX_SCRATCHPAD_BODY_BYTES) {
    throw new CliError(
      `scratchpad body is ${editedBuffer.length} bytes; limit is ${MAX_SCRATCHPAD_BODY_BYTES} bytes; edited draft preserved at ${filename}`,
    );
  }
  let edited: string;
  try {
    edited = decodeMarkdown(editedBuffer, "edited scratchpad");
  } catch (error) {
    throw new CliError(`${(error as Error).message}; edited draft preserved at ${filename}`);
  }
  if (edited === pad.body) {
    removeDraft(directory, filename);
    if (flagBool(ctx.args, "json"))
      ctx.out(
        `${JSON.stringify({ ...padSummary(pad, ctx.store.listScratchpadAttachments(pad.id).length), unchanged: true })}\n`,
      );
    else ctx.out(`scratchpad #${pad.id} unchanged\n`);
    return 0;
  }
  try {
    const completionTime = Date.now();
    if (ctx.identity) ctx.store.touchSession(ctx.identity.key, completionTime);
    const updated = service(ctx, () => completionTime).replace(pad.id, edited, revision, actor(ctx, "cli-editor"));
    removeDraft(directory, filename);
    if (flagBool(ctx.args, "json"))
      ctx.out(`${JSON.stringify(padSummary(updated, ctx.store.listScratchpadAttachments(updated.id).length))}\n`);
    else ctx.out(`✓ edited scratchpad #${updated.id} r${updated.revision}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ScratchpadConflictError) {
      throw new CliError(`${error.message}; edited draft preserved at ${filename}`);
    }
    throw error;
  }
}

export async function run(ctx: Ctx): Promise<number> {
  try {
    const subcommand = ctx.args._[1] ?? "list";
    if (subcommand === "help") {
      usage(ctx);
      return 0;
    }
    if (!OBSERVER_SUBCOMMANDS.has(subcommand) && !MUTATING_SUBCOMMANDS.has(subcommand)) {
      throw new CliError(`unknown scratchpad subcommand: ${subcommand}`);
    }
    const pads = service(ctx);
    if (subcommand === "list") {
      writeList(ctx, pads.list(states(ctx), resultLimit(ctx, 50, 500)));
      return 0;
    }
    if (subcommand === "find") {
      const query = requireArg(rest(ctx.args, 2), "query");
      writeList(ctx, pads.find(query, states(ctx), resultLimit(ctx, 50, 500)));
      return 0;
    }
    if (subcommand === "read") {
      writePad(ctx, pads.get(padId(ctx.args._[2])));
      return 0;
    }
    if (subcommand === "history") {
      const id = padId(ctx.args._[2]);
      const full = flagBool(ctx.args, "full");
      const revisions = pads.history(id, resultLimit(ctx, 100, 500));
      if (flagBool(ctx.args, "json")) ctx.out(`${JSON.stringify(revisions.map((row) => revisionJson(row, full)))}\n`);
      else
        for (const [index, row] of revisions.entries()) {
          ctx.out(
            `r${row.revision} ${row.action} [${row.state}] ${row.actorKind}${row.actorHarness ? `:${row.actorHarness}` : ""}${row.reason ? ` — ${row.reason}` : ""}\n`,
          );
          if (full) {
            if (row.body) ctx.out(`${row.body}${row.body.endsWith("\n") ? "" : "\n"}`);
            if (index < revisions.length - 1) ctx.out("\n");
          }
        }
      return 0;
    }
    if (subcommand === "create") {
      const created = pads.create(requireArg(bodyCommandRest(ctx, 2), "title"), await bodyInput(ctx), actor(ctx));
      if (flagBool(ctx.args, "json")) ctx.out(`${JSON.stringify(padSummary(created, 0))}\n`);
      else ctx.out(`✓ created scratchpad #${created.id} r${created.revision}: ${created.title}\n`);
      return 0;
    }
    if (subcommand === "use") {
      const id = requireIdentity(ctx.identity);
      if (!ctx.repo.worktreeId) throw new CliError("cannot attach without a resolved worktree");
      const attachment = pads.use(padId(ctx.args._[2]), { sessionId: id.key, worktreeId: ctx.repo.worktreeId });
      if (flagBool(ctx.args, "json"))
        ctx.out(`${JSON.stringify({ scratchpadId: attachment.scratchpadId, attached: true })}\n`);
      else ctx.out(`✓ using scratchpad #${attachment.scratchpadId}\n`);
      return 0;
    }

    const id = padId(ctx.args._[2]);
    const current = pads.get(id);
    let updated: ScratchpadRow;
    switch (subcommand) {
      case "replace":
        updated = pads.replace(id, await bodyInput(ctx), expectedRevision(ctx, current), actor(ctx));
        break;
      case "append":
        updated = pads.append(id, await bodyInput(ctx), expectedRevision(ctx, current), actor(ctx));
        break;
      case "edit-section": {
        const heading = flagStr(ctx.args, "section") ?? requireArg(bodyCommandRest(ctx, 3), "heading");
        updated = pads.editSection(id, heading, await bodyInput(ctx), expectedRevision(ctx, current), actor(ctx));
        break;
      }
      case "rename":
        updated = pads.rename(id, requireArg(rest(ctx.args, 3), "title"), expectedRevision(ctx, current), actor(ctx));
        break;
      case "edit":
        return runEditor(ctx, current);
      case "archive":
        updated = pads.archive(id, expectedRevision(ctx, current), actor(ctx), caller(ctx));
        break;
      case "restore":
        updated = pads.restore(id, expectedRevision(ctx, current), actor(ctx));
        break;
      case "trash":
        updated = pads.trash(
          id,
          expectedRevision(ctx, current),
          actor(ctx),
          caller(ctx),
          (flagStr(ctx.args, "reason") ?? rest(ctx.args, 3)) || null,
        );
        break;
      case "recover":
        updated = pads.recover(id, expectedRevision(ctx, current), actor(ctx));
        break;
      default:
        throw new CliError(`unknown scratchpad subcommand: ${subcommand}`);
    }
    if (flagBool(ctx.args, "json"))
      ctx.out(`${JSON.stringify(padSummary(updated, ctx.store.listScratchpadAttachments(updated.id).length))}\n`);
    else ctx.out(`✓ ${subcommand} scratchpad #${updated.id} r${updated.revision}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof ScratchpadError) throw new CliError(error.message);
    throw error;
  }
}
