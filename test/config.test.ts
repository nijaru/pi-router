import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { RoutingProfile } from "../src/types.ts";

function tempJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-router-config-"));
  const path = join(dir, "pi-router.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function profile(id: string, model = "model-x"): RoutingProfile {
  return {
    id,
    description: `${id} scope`,
    targets: [{ provider: "prov", model, thinkingLevel: "high" }],
  };
}

test("environment mode overrides the default", () => {
  const config = loadConfig({ env: { PI_ROUTER_MODE: "auto" } });
  assert.equal(config.mode, "auto");
});

test("PI_ROUTER_OFF forces config off", () => {
  const config = loadConfig({ env: { PI_ROUTER_MODE: "auto", PI_ROUTER_OFF: "1" } });
  assert.equal(config.mode, "off");
});

test("project profiles replace the global profile list", () => {
  const globalPath = tempJson({ profiles: [profile("global")] });
  const projectPath = tempJson({ profiles: [profile("a"), profile("b")] });
  const config = loadConfig({ globalPath, projectPath, env: {} });
  assert.deepEqual(
    config.profiles.map((entry) => entry.id),
    ["a", "b"],
  );
});

test("project thresholds merge with the default", () => {
  const projectPath = tempJson({ thresholds: { downgradeProbability: 0.99 } });
  const config = loadConfig({ projectPath, env: {} });
  assert.equal(config.thresholds.sufficientProbability, 0.8);
  assert.equal(config.thresholds.downgradeProbability, 0.99);
});

test("rejects duplicate profile ids", () => {
  const projectPath = tempJson({ profiles: [profile("dup"), profile("dup")] });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /duplicate profile id "dup"/);
});

test("rejects a profile without a description", () => {
  const projectPath = tempJson({ profiles: [{ id: "a", targets: [{ provider: "p", model: "m", thinkingLevel: "high" }] }] });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /description must be a non-empty string/);
});

test("rejects a profile without targets", () => {
  const projectPath = tempJson({ profiles: [{ id: "a", description: "scope", targets: [] }] });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /targets must be a non-empty array/);
});

test("rejects an invalid target", () => {
  const projectPath = tempJson({ profiles: [{ id: "a", description: "scope", targets: [{ provider: "p", model: "m" }] }] });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /contains an invalid target/);
});

test("rejects an invalid profile id", () => {
  const projectPath = tempJson({ profiles: [profile("has space")] });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /stable identifier/);
});

test("rejects a fractional character budget", () => {
  const projectPath = tempJson({ jev: { maxHistoryChars: 0.5 } });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /positive integer/);
});

test("rejects an unknown threshold key", () => {
  const projectPath = tempJson({ thresholds: { sufficientProbabilty: 0.9 } });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /unknown threshold/);
});

test("rejects thresholds whose downgrade bound is weaker than sufficiency", () => {
  const projectPath = tempJson({ thresholds: { sufficientProbability: 0.9, downgradeProbability: 0.5 } });
  assert.throws(() => loadConfig({ projectPath, env: {} }), /downgradeProbability .* must be >=/);
});
