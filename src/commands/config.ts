import { CONFIG_KEYS } from "../config.ts";
import type { Ctx } from "../context.ts";

export function run(ctx: Ctx): number {
  const key = ctx.args._[1];
  const value = ctx.args._[2];

  if (!key) {
    for (const k of CONFIG_KEYS) ctx.out(`${k} = ${ctx.store.getMeta(k) ?? "(default)"}\n`);
    return 0;
  }
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    ctx.err(`unknown config key: ${key}\n  valid keys: ${CONFIG_KEYS.join(", ")}\n`);
    return 1;
  }
  if (value === undefined) {
    ctx.out(`${key} = ${ctx.store.getMeta(key) ?? "(default)"}\n`);
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    ctx.err("value must be a positive number of seconds\n");
    return 1;
  }
  ctx.store.setMeta(key, String(Math.floor(n)));
  ctx.out(`✓ ${key} = ${Math.floor(n)}\n`);
  return 0;
}
