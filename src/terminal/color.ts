import { flagBool, flagStr, type ParsedArgs } from "../args.ts";

type Paint = (text: string) => string;
type Severity = "clear" | "info" | "stale" | "soft" | "hard";

export interface TerminalTheme {
  enabled: boolean;
  accent: Paint;
  danger: Paint;
  dim: Paint;
  heading: Paint;
  kind(kind: string): string;
  path: Paint;
  pin: Paint;
  severity(severity: Severity, text: string): string;
  success: Paint;
  warn: Paint;
}

export interface ColorOptions {
  args?: ParsedArgs;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (text: string): string => text;

function paint(enabled: boolean, code: string): Paint {
  return enabled ? (text) => `\x1b[${code}m${text}\x1b[0m` : plain;
}

function wantsColor(opts: ColorOptions): boolean {
  const args = opts.args;
  if (args && flagBool(args, "no-color")) return false;

  const explicit = args ? flagStr(args, "color") : undefined;
  if (explicit) {
    const value = explicit.toLowerCase();
    if (value === "always" || value === "true" || value === "1") return true;
    if (value === "never" || value === "false" || value === "0") return false;
  }
  if (args && flagBool(args, "color")) return true;

  const env = opts.env ?? {};
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return opts.isTTY ?? false;
}

export function createTheme(opts: ColorOptions = {}): TerminalTheme {
  const enabled = wantsColor(opts);
  const dim = paint(enabled, "38;5;245");
  const accent = paint(enabled, "38;5;116");
  const warn = paint(enabled, "38;5;179");
  const danger = paint(enabled, "38;5;174");
  const success = paint(enabled, "38;5;151");
  const path = paint(enabled, "38;5;153");
  const pin = paint(enabled, "38;5;178");
  const note = paint(enabled, "38;5;183");
  const run = paint(enabled, "38;5;250");
  return {
    enabled,
    accent,
    danger,
    dim,
    heading: paint(enabled, "1;38;5;152"),
    kind(kind: string): string {
      if (kind === "claim") return warn(kind);
      if (kind === "done") return success(kind);
      if (kind === "note") return note(kind);
      if (kind === "delete") return danger(kind);
      if (kind === "edit" || kind === "create") return path(kind);
      if (kind === "task") return accent(kind);
      return run(kind);
    },
    path,
    pin,
    severity(severity, text) {
      if (severity === "hard") return danger(text);
      if (severity === "soft") return warn(text);
      if (severity === "clear") return success(text);
      return dim(text);
    },
    success,
    warn,
  };
}

export function themeFromCtx(ctx: { args: ParsedArgs; env: Record<string, string | undefined> }): TerminalTheme {
  return createTheme({ args: ctx.args, env: ctx.env, isTTY: process.stdout.isTTY });
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export const plainTheme: TerminalTheme = createTheme({ isTTY: false });
