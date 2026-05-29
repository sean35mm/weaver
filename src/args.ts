/** Tiny zero-dependency argv parser. Positionals in `_`, `--flag[=value]` / `-x` in `flags`. */

export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (booleanFlags.has(body)) {
        flags[body] = true; // known boolean → don't consume the next token
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      _.push(a);
    }
  }

  return { _, flags };
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/** Free-text positional tail (e.g. an intent or note typed without quotes). */
export function rest(args: ParsedArgs, from: number): string {
  return args._.slice(from).join(" ").trim();
}
