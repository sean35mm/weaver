import { stripAnsi } from "./color.ts";

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function terminalWidth(width?: number): number {
  return Math.max(40, width ?? process.stdout.columns ?? 100);
}

export function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const marker = width <= 3 ? ".".repeat(width) : "...";

  let out = "";
  let visible = 0;
  let sawAnsi = false;
  const limit = width - marker.length;
  for (let i = 0; i < text.length && visible < limit; i++) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end >= 0) {
        sawAnsi = true;
        out += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += text[i];
    visible++;
  }
  return out + marker + (sawAnsi ? "\x1b[0m" : "");
}

function normalizeWords(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.split(" ") : [];
}

function pushWord(line: string, word: string, limit: number): { line: string; overflow: string | null } {
  const candidate = line ? `${line} ${word}` : word;
  if (visibleLength(candidate) <= limit) return { line: candidate, overflow: null };
  if (line) return { line, overflow: word };
  return { line: truncateVisible(word, limit), overflow: null };
}

export function wrapWords(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  const words = normalizeWords(text);
  if (!words.length) return [""];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = pushWord(line, word, limit);
    if (next.overflow) {
      lines.push(next.line);
      line = "";
      const retry = pushWord(line, next.overflow, limit);
      line = retry.line;
    } else {
      line = next.line;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function wrapWithPrefix(prefix: string, text: string, width: number, continuationIndent?: string): string[] {
  const indent = continuationIndent ?? " ".repeat(visibleLength(prefix));
  const firstWidth = Math.max(8, width - visibleLength(prefix));
  const restWidth = Math.max(8, width - visibleLength(indent));
  const words = normalizeWords(text);
  if (!words.length) return [prefix.trimEnd()];

  const lines: string[] = [];
  let line = "";
  let limit = firstWidth;

  for (const word of words) {
    const next = pushWord(line, word, limit);
    if (next.overflow) {
      lines.push(lines.length ? indent + next.line : prefix + next.line);
      line = "";
      limit = restWidth;
      const retry = pushWord(line, next.overflow, limit);
      line = retry.line;
    } else {
      line = next.line;
    }
  }

  if (line || !lines.length) lines.push(lines.length ? indent + line : prefix + line);
  return lines;
}
