import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildJevRequest, JevError, parseJevResponse } from "../src/jev.ts";

const profiles = [
  { id: "routine", description: "routine scope" },
  { id: "substantial", description: "substantial scope" },
  { id: "strategic", description: "strategic scope" },
];

test("asks one sufficiency question per available profile with its description", () => {
  const request = buildJevRequest({ prompt: "refactor this module", profiles }, DEFAULT_CONFIG.jev);
  const questions = request.questions as Record<string, { instructions: string; type: string }>;
  assert.deepEqual(Object.keys(questions), ["routine", "strategic", "substantial"]);
  for (const profile of profiles) {
    assert.equal(questions[profile.id].type, "noul");
    assert.match(questions[profile.id].instructions, new RegExp(profile.description));
  }
});

test("does not disclose the current model, profile order, or pricing", () => {
  const request = buildJevRequest({ prompt: "refactor this module", project: "pi-router", profiles }, DEFAULT_CONFIG.jev);
  const serialized = JSON.stringify(request);
  assert.doesNotMatch(serialized, /current_model|current_thinking|selected_model|price|cost_rank/i);
  const state = request.state as { environment: Record<string, unknown> };
  assert.deepEqual(Object.keys(state.environment), ["project"]);
});

test("includes privacy guardrails and compact history", () => {
  const request = buildJevRequest(
    { prompt: "continue", history: "user: earlier ask\n\nassistant: earlier answer", profiles },
    DEFAULT_CONFIG.jev,
  );
  assert.deepEqual(request.provider, { zdr: true, data_collection: "deny" });
  const state = request.state as { recent_context: string };
  assert.match(state.recent_context, /earlier ask/);
});

test("parses per-profile answers by id regardless of response order", () => {
  const parsed = parseJevResponse(
    {
      model: "typesafe/jev-1.13-20260917",
      answers: {
        strategic: { type: "noul", noul: 0.2 },
        routine: { type: "noul", noul: 0.91 },
      },
      usage: { input_tokens: 200, cost: 0.00001 },
    },
    ["routine", "strategic"],
    123,
  );
  assert.deepEqual(parsed.profiles, [
    { id: "routine", probability: 0.91 },
    { id: "strategic", probability: 0.2 },
  ]);
  assert.equal(parsed.latencyMs, 123);
  assert.equal(parsed.usage?.inputTokens, 200);
});

test("throws when an available profile has no answer", () => {
  assert.throws(
    () => parseJevResponse({ answers: { routine: { noul: 0.5 } } }, ["routine", "strategic"], 0),
    (error: unknown) => error instanceof JevError && /strategic/.test(error.message),
  );
});

test("throws when a probability is outside [0, 1]", () => {
  assert.throws(
    () => parseJevResponse({ answers: { routine: { noul: 9 } } }, ["routine"], 0),
    (error: unknown) => error instanceof JevError && /valid answer/.test(error.message),
  );
});
