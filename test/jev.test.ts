import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildJevRequest, parseJevResponse } from "../src/jev.ts";

test("builds an OpenRouter decisions request with privacy guardrails", () => {
  const request = buildJevRequest(
    { prompt: "refactor this module", history: "assistant: previous work", project: "pi-router" },
    DEFAULT_CONFIG.jev,
  );
  assert.equal(request.model, "typesafe/jev-1.13");
  assert.deepEqual(request.provider, { zdr: true, data_collection: "deny" });
  assert.ok(request.questions && typeof request.questions === "object");
});

test("parses required Jev answers", () => {
  const parsed = parseJevResponse(
    {
      model: "typesafe/jev-1.13-20260917",
      answers: {
        low_effort_sufficient: { type: "noul", noul: 0.91 },
        expert_materially_better: { type: "noul", noul: 0.08 },
        reasoning_depth: { type: "score", score: 0.7 },
      },
      usage: { input_tokens: 200, cost: 0.00001 },
    },
    123,
  );
  assert.equal(parsed.lowEffortSufficient, 0.91);
  assert.equal(parsed.expertMateriallyBetter, 0.08);
  assert.equal(parsed.reasoningDepth, 0.7);
  assert.equal(parsed.latencyMs, 123);
  assert.equal(parsed.usage?.inputTokens, 200);
});
