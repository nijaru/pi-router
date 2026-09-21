import test from "node:test";
import assert from "node:assert/strict";
import { chooseProfile } from "../src/policy.ts";
import type { ProfileAssessment, RouterThresholds } from "../src/types.ts";

const thresholds: RouterThresholds = { sufficientProbability: 0.8, downgradeProbability: 0.95 };

function profiles(probabilities: readonly number[]): ProfileAssessment[] {
  return probabilities.map((probability, index) => ({ id: `p${index}`, probability }));
}

test("selects the first profile when it is sufficient", () => {
  const result = chooseProfile(profiles([0.9, 0.4, 0.2]), thresholds);
  assert.equal(result.selected, "p0");
  assert.equal(result.desired, "p0");
  assert.equal(result.held, false);
});

test("selects a middle profile when cheaper ones are insufficient", () => {
  const result = chooseProfile(profiles([0.5, 0.9, 0.85]), thresholds);
  assert.equal(result.selected, "p1");
  assert.equal(result.desired, "p1");
});

test("uses the last profile as the safest fallback when none qualify", () => {
  const result = chooseProfile(profiles([0.3, 0.5, 0.4]), thresholds);
  assert.equal(result.selected, "p2");
  assert.equal(result.desired, "p2");
  assert.match(result.reason, /safest fallback/);
});

test("upgrades immediately", () => {
  const result = chooseProfile(profiles([0.4, 0.9, 0.95]), thresholds, "p0");
  assert.equal(result.selected, "p1");
  assert.equal(result.held, false);
});

test("holds a marginal downgrade", () => {
  const result = chooseProfile(profiles([0.9, 0.7, 0.6]), thresholds, "p2");
  assert.equal(result.desired, "p0");
  assert.equal(result.selected, "p2");
  assert.equal(result.held, true);
  assert.match(result.reason, /marginal downgrade/);
});

test("allows a confident downgrade", () => {
  const result = chooseProfile(profiles([0.99, 0.7, 0.6]), thresholds, "p2");
  assert.equal(result.desired, "p0");
  assert.equal(result.selected, "p0");
  assert.equal(result.held, false);
});

test("does not treat an unknown current profile as a downgrade", () => {
  const result = chooseProfile(profiles([0.9, 0.7]), thresholds, "unknown");
  assert.equal(result.selected, "p0");
  assert.equal(result.held, false);
});
