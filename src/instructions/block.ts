/**
 * The fenced instruction block injected into agent instruction files. In the CLI-first model
 * this text is the activation mechanism, so it's kept tight and is the main tuning target.
 * Inject/remove are idempotent via the start/end markers.
 */

export const BLOCK_START_MARKER = "<!-- weaver:start";
export const BLOCK_END_MARKER = "<!-- weaver:end -->";
export const INSTRUCTION_PROTOCOL_VERSION = 4;

export const INSTRUCTION_BLOCK = `<!-- weaver:start protocol=${INSTRUCTION_PROTOCOL_VERSION} -->
Run \`weaver status\` every task. Read-only/plan-only: stop after status unless it/user identifies a
pad; read only—no create/use/claim/done.

Before writes: \`weaver task "<goal>"\`; use a pad only for a matching active pad, collaborators,
handoff/resumption, conflict/shared decisions, or user request—not complexity/duration; claim every
scope once before editing.

If \`claim\` exits 1, it WAS recorded: don't rerun. Read intent/reason/activity/pad. Prefer other work; proceed only if harmless,
otherwise coordinate/ask; never silently overwrite. Different-worktree: informational; coordinate integration.

If using a pad: curate Markdown; read its revision and merge stale conflicts.
Archive only when the whole workstream is complete. Trash only empty/duplicate/obsolete pads with
reason+revision and no live attachments; recover mistakes. Keep secrets/PII out. Lasting knowledge:
Repository Facts (\`fact\`; correct: \`--update\`; retire: \`forget\`).

Before commit/push/PR: exactly \`weaver preflight --staged\`, \`weaver preflight --upstream\`, or
\`weaver preflight --base <ref>\`; pause on overlaps. Write sessions finish with \`weaver done\`.
<!-- weaver:end -->`;

export type InstructionBlockStatus = "current" | "outdated" | "missing" | "foreign";

interface Range {
  start: number;
  end: number;
}

function blockRange(contents: string): Range | null {
  const start = contents.indexOf(BLOCK_START_MARKER);
  if (start < 0) return null;
  if (contents.indexOf(BLOCK_START_MARKER, start + BLOCK_START_MARKER.length) >= 0) return null;
  const endMarker = contents.indexOf(BLOCK_END_MARKER, start);
  if (endMarker < 0) return null;
  if (contents.indexOf(BLOCK_END_MARKER, endMarker + BLOCK_END_MARKER.length) >= 0) return null;
  const openerEnd = contents.indexOf("\n", start);
  const opener = contents.slice(start, openerEnd < 0 || openerEnd > endMarker ? endMarker : openerEnd).trim();
  const versioned = /^<!-- weaver:start protocol=\d+(?: — managed by Weaver;[^>]*)? -->$/.test(opener);
  const legacy = /^<!-- weaver:start — managed by Weaver;[^>]* -->$/.test(opener);
  if (!versioned && !legacy) return null;
  return { start, end: endMarker + BLOCK_END_MARKER.length };
}

export function instructionBlockStatus(contents: string): InstructionBlockStatus {
  const range = blockRange(contents);
  if (!range) {
    return contents.includes(BLOCK_START_MARKER) || contents.includes(BLOCK_END_MARKER) ? "foreign" : "missing";
  }
  return contents.slice(range.start, range.end) === INSTRUCTION_BLOCK ? "current" : "outdated";
}

export function hasBlock(contents: string): boolean {
  return blockRange(contents) !== null;
}

/** Idempotent: replace an existing block in place, else append it. */
export function injectBlock(contents: string): string {
  const range = blockRange(contents);
  if (range) {
    return contents.slice(0, range.start) + INSTRUCTION_BLOCK + contents.slice(range.end);
  }
  if (instructionBlockStatus(contents) === "foreign") return contents;
  if (contents.trim() === "") return `${INSTRUCTION_BLOCK}\n`;
  const sep = contents.endsWith("\n") ? "\n" : "\n\n";
  return `${contents}${sep}${INSTRUCTION_BLOCK}\n`;
}

/** Remove the block and tidy surrounding blank lines. */
export function removeBlock(contents: string): string {
  const range = blockRange(contents);
  if (!range) return contents;
  const before = contents.slice(0, range.start).replace(/\n+$/, "\n");
  const after = contents.slice(range.end).replace(/^\n+/, "");
  return `${before}${after}`.replace(/\n{3,}/g, "\n\n");
}
