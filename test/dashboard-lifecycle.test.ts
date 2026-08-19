import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canApplyLifecycleResult,
  type LifecycleGuard,
  sameLifecycleState,
  sameLifecycleTarget,
} from "../web/dashboard/lifecycle.ts";

const guard: LifecycleGuard = {
  padId: 7,
  revision: 3,
  generation: 11,
  title: "Plan",
  body: "# Plan",
  conflicted: false,
};

test("lifecycle guards reject changed selections and preserve changed drafts", () => {
  assert.equal(sameLifecycleTarget(guard, { ...guard }), true);
  assert.equal(sameLifecycleState(guard, { ...guard }), true);
  assert.equal(canApplyLifecycleResult(guard, { ...guard }), true);

  assert.equal(sameLifecycleTarget(guard, { ...guard, padId: 8 }), false);
  assert.equal(sameLifecycleTarget(guard, { ...guard, generation: 12 }), false);
  assert.equal(canApplyLifecycleResult(guard, { ...guard, revision: 4 }), false);
  assert.equal(canApplyLifecycleResult(guard, { ...guard, title: "Edited" }), false);
  assert.equal(canApplyLifecycleResult(guard, { ...guard, body: "local draft" }), false);
  assert.equal(sameLifecycleState({ ...guard, conflicted: true }, { ...guard, conflicted: true }), true);
  assert.equal(canApplyLifecycleResult(guard, { ...guard, conflicted: true }), false);
  assert.equal(canApplyLifecycleResult(guard, null), false);
});
