import type { Ctx } from "../context.ts";

export function runDisable(ctx: Ctx): number {
  ctx.store.setMeta("enabled", "0");
  ctx.out("✓ weaver disabled for this project — agent writes are paused. `weaver enable` to resume.\n");
  return 0;
}

export function runEnable(ctx: Ctx): number {
  ctx.store.setMeta("enabled", "1");
  ctx.out("✓ weaver enabled for this project.\n");
  return 0;
}
