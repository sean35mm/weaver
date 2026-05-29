/**
 * The fenced instruction block injected into CLAUDE.md / AGENTS.md. In the CLI-first model
 * this text is the activation mechanism, so it's kept tight and is the main tuning target.
 * Inject/remove are idempotent via the start/end markers.
 */

export const BLOCK_START_MARKER = "<!-- weaver:start";
export const BLOCK_END_MARKER = "<!-- weaver:end -->";

export const INSTRUCTION_BLOCK = `<!-- weaver:start — managed by Weaver; re-run \`weaver init\` to update, \`weaver deinit\` to remove -->
## Weaver — shared agent context

Other agents may be working in this repo right now. Weaver is a local CLI that keeps you
aware of them. If the \`weaver\` command isn't found, ignore this section.

**Do these every task (high value, low effort):**
- **At the start:** run \`weaver status\` to see who's active, their intent, claimed areas,
  and notes; then \`weaver task "<your goal>"\`.
- **Claim the area you'll work in, once:** \`weaver claim '<glob>' --reason "<why>"\`
  (e.g. \`weaver claim 'src/auth/**' --reason "refactoring token flow"\`).
- **Record durable learnings** about this repo (gotchas, conventions, "X breaks Y"):
  \`weaver note "<learning>"\`.
- **When finished:** \`weaver done\`.

**On a conflict** (\`status\`/\`claim\` shows another *live* session in your area): read their
intent + reason + recent activity, then — (1) prefer to work elsewhere and re-check later;
(2) if the overlap is harmless, proceed; (3) if you're blocked, \`weaver note\` your intent
and **ask the user how to split the work**. Never silently edit over another agent's active
area.

**Optional (when useful):** \`weaver check <path>\` before touching a file you're unsure
about; \`weaver log <kind> <path> "<summary>"\` after a notable change so others see it.

Keep reasons/notes short and specific — other agents read them to coordinate.
<!-- weaver:end -->`;

interface Range {
  start: number;
  end: number;
}

function blockRange(contents: string): Range | null {
  const start = contents.indexOf(BLOCK_START_MARKER);
  if (start < 0) return null;
  const endMarker = contents.indexOf(BLOCK_END_MARKER, start);
  if (endMarker < 0) return null;
  return { start, end: endMarker + BLOCK_END_MARKER.length };
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
