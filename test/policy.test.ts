import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { chooseRoute } from "../src/policy.ts";
import type { RouteAnalysis } from "../src/types.ts";

function analysis(overrides: Partial<RouteAnalysis>): RouteAnalysis {
  return {
    lowEffortSufficient: 0.5,
    expertMateriallyBetter: 0.2,
    reasoningDepth: 1.2,
    latencyMs: 100,
    ...overrides,
  };
}

test("routes obvious work to fast", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.96, expertMateriallyBetter: 0.02, reasoningDepth: 0.2 }),
    DEFAULT_CONFIG.thresholds,
  );
  assert.equal(result.selected, "fast");
});

test("routes bounded reasoning to capable", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.45, expertMateriallyBetter: 0.18, reasoningDepth: 1.4 }),
    DEFAULT_CONFIG.thresholds,
  );
  assert.equal(result.selected, "capable");
});

test("routes material expert benefit to expert", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.1, expertMateriallyBetter: 0.82, reasoningDepth: 2.0 }),
    DEFAULT_CONFIG.thresholds,
  );
  assert.equal(result.selected, "expert");
});

test("routes architectural depth to expert even with mixed expert probability", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.2, expertMateriallyBetter: 0.35, reasoningDepth: 2.8 }),
    DEFAULT_CONFIG.thresholds,
  );
  assert.equal(result.selected, "expert");
});

test("holds expert on marginal downgrade", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.65, expertMateriallyBetter: 0.25, reasoningDepth: 1.1 }),
    DEFAULT_CONFIG.thresholds,
    "expert",
  );
  assert.equal(result.desired, "capable");
  assert.equal(result.selected, "expert");
  assert.equal(result.held, true);
});

test("allows expert downgrade when evidence is strong", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.96, expertMateriallyBetter: 0.03, reasoningDepth: 0.2 }),
    DEFAULT_CONFIG.thresholds,
    "expert",
  );
  assert.equal(result.selected, "fast");
  assert.equal(result.held, false);
});

test("allows expert to step down to capable when expert need is clearly low", () => {
  const result = chooseRoute(
    analysis({ lowEffortSufficient: 0.4, expertMateriallyBetter: 0.08, reasoningDepth: 1.4 }),
    DEFAULT_CONFIG.thresholds,
    "expert",
  );
  assert.equal(result.desired, "capable");
  assert.equal(result.selected, "capable");
  assert.equal(result.held, false);
});
