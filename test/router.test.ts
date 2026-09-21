import test from "node:test";
import assert from "node:assert/strict";
import { Harness, answers, type HarnessOptions } from "./harness.ts";

const DEEPSEEK = { provider: "deepseek", id: "deepseek-flash" };
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };

const THREE_PROFILES = {
  mode: "auto",
  profiles: [
    {
      id: "routine",
      description: "routine scope",
      targets: [{ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "low" }],
    },
    {
      id: "substantial",
      description: "substantial scope",
      targets: [{ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" }],
    },
    {
      id: "strategic",
      description: "strategic scope",
      targets: [{ provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "high" }],
    },
  ],
};

/** Answer every asked profile, defaulting unlisted ones to a low probability. */
function responder(probabilities: Record<string, number>): HarnessOptions["respond"] {
  return (body) => {
    const questions = body.questions as Record<string, unknown>;
    return answers(Object.fromEntries(Object.keys(questions).map((id) => [id, probabilities[id] ?? 0.1])));
  };
}

function questionIds(body: Record<string, unknown>): string[] {
  return Object.keys(body.questions as Record<string, unknown>);
}

async function withHarness(options: HarnessOptions, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = new Harness({ providerApiKey: "test-key", ...options });
  try {
    await fn(harness);
  } finally {
    harness.dispose();
  }
}

test("routes to the first sufficient profile and applies its target", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95, substantial: 0.5, strategic: 0.2 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("fix a typo in the readme");

      assert.equal(harness.fetchCalls.length, 1);
      assert.deepEqual(questionIds(harness.fetchCalls[0].body), ["routine", "strategic", "substantial"]);
      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "low");
    },
  );
});

test("selects a middle profile from its own answer", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.2, substantial: 0.95, strategic: 0.1 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("refactor the parser");

      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "high");
    },
  );
});

test("uses the safest profile when none clear the threshold", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.3, substantial: 0.4, strategic: 0.2 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("unknown hard task");

      assert.deepEqual(harness.model, ASTRA);
      assert.equal(harness.thinking, "high");
    },
  );
});

test("excludes unavailable profiles before asking Jev", async () => {
  await withHarness(
    { models: [DEEPSEEK], respond: responder({ routine: 0.3, substantial: 0.9 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("refactor the parser");

      assert.deepEqual(questionIds(harness.fetchCalls[0].body), ["routine", "substantial"]);
      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "high");
    },
  );
});

test("falls back to the first available target within a profile", async () => {
  await withHarness(
    { models: [DEEPSEEK], respond: responder({ solo: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig({
        mode: "auto",
        profiles: [
          {
            id: "solo",
            description: "solo scope",
            targets: [
              { provider: "missing", model: "ghost", thinkingLevel: "high" },
              { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" },
            ],
          },
        ],
      });
      await harness.start();
      await harness.turn("do the work");

      assert.deepEqual(questionIds(harness.fetchCalls[0].body), ["solo"]);
      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "high");
    },
  );
});

test("keeps the current model when no configured profile is available", async () => {
  await withHarness({ models: [DEEPSEEK] }, async (harness) => {
    harness.writeProjectConfig({
      mode: "auto",
      profiles: [
        {
          id: "solo",
          description: "solo scope",
          targets: [{ provider: "missing", model: "ghost", thinkingLevel: "high" }],
        },
      ],
    });
    await harness.start();
    harness.model = DEEPSEEK;
    await harness.turn("do the work");

    assert.equal(harness.fetchCalls.length, 0);
    assert.deepEqual(harness.model, DEEPSEEK);
    assert.match(harness.notifications.at(-1)?.message ?? "", /no configured profile/);
  });
});

test("does not disclose the current model to Jev", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      harness.model = ASTRA;
      await harness.start();
      await harness.turn("do the work");

      const serialized = JSON.stringify(harness.fetchCalls[0].body);
      assert.doesNotMatch(serialized, /gpt-6-astra|deepseek-flash/);
    },
  );
});

test("sends compact recent context for follow-ups", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      harness.branch.push(
        { type: "message", message: { role: "user", content: "redesign the router" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I refactored policy." }] } },
      );
      await harness.start();
      await harness.turn("continue");

      const state = harness.fetchCalls[0].body.state as { recent_context: string };
      assert.match(state.recent_context, /redesign the router/);
      assert.match(state.recent_context, /I refactored policy/);
    },
  );
});

test("manual model selection suspends auto routing and /router auto resumes it", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("first");
      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.fetchCalls.length, 1);

      harness.selectModel(ASTRA);
      await harness.turn("second");
      assert.equal(harness.fetchCalls.length, 1, "manual override should suspend classification");
      assert.deepEqual(harness.model, ASTRA);

      await harness.command("auto");
      await harness.turn("third");
      assert.equal(harness.fetchCalls.length, 2, "/router auto should resume classification");
      assert.deepEqual(harness.model, DEEPSEEK);
    },
  );
});

test("router-originated model and thinking events are not manual overrides", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("first");
      await harness.turn("second");

      assert.equal(harness.fetchCalls.length, 2, "router-applied events must not suspend routing");
      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "low");
    },
  );
});

test("delayed router thinking events are not treated as manual overrides", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }), thinkingDispatchDelayMs: 5 },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("first");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await harness.turn("second");

      assert.equal(harness.fetchCalls.length, 2, "a late thinking event must not suspend routing");
      assert.deepEqual(harness.model, DEEPSEEK);
    },
  );
});

test("recognizes a clamped target as the current profile", async () => {
  await withHarness(
    {
      models: [DEEPSEEK, ASTRA],
      supportedThinking: ["off", "minimal", "low", "medium", "high"],
      respond: (body, call) => {
        const questions = body.questions as Record<string, unknown>;
        const probabilities: Record<string, number> =
          call === 1
            ? { routine: 0.1, substantial: 0.1, strategic: 0.9 }
            : { routine: 0.9, substantial: 0.7, strategic: 0.6 };
        return answers(Object.fromEntries(Object.keys(questions).map((id) => [id, probabilities[id] ?? 0.1])));
      },
    },
    async (harness) => {
      harness.writeProjectConfig({
        mode: "auto",
        profiles: [
          { id: "routine", description: "routine scope", targets: [{ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "low" }] },
          { id: "substantial", description: "substantial scope", targets: [{ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" }] },
          { id: "strategic", description: "strategic scope", targets: [{ provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "xhigh" }] },
        ],
      });
      await harness.start();

      await harness.turn("first");
      assert.deepEqual(harness.model, ASTRA);
      assert.equal(harness.thinking, "high", "xhigh should clamp to high");

      await harness.turn("second");
      assert.deepEqual(harness.model, ASTRA, "the clamped target is still the current profile");
    },
  );
});

test("excludes stale scoped models that Pi can no longer use", async () => {
  await withHarness(
    {
      models: [DEEPSEEK],
      scopedModels: [DEEPSEEK, ASTRA],
      respond: responder({ routine: 0.9, substantial: 0.9, strategic: 0.9 }),
    },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("do the work");

      assert.deepEqual(questionIds(harness.fetchCalls[0].body), ["routine", "substantial"]);
    },
  );
});

test("ignores project config when the project is untrusted", async () => {
  await withHarness(
    {
      models: [DEEPSEEK, ASTRA],
      projectTrusted: false,
      respond: responder({ routine: 0.9, substantial: 0.9, strategic: 0.9 }),
    },
    async (harness) => {
      harness.writeProjectConfig({
        mode: "auto",
        profiles: [
          { id: "evil", description: "evil scope", targets: [{ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "low" }] },
        ],
      });
      await harness.start();
      harness.model = ASTRA;
      await harness.turn("do the work");

      assert.ok(!questionIds(harness.fetchCalls[0].body).includes("evil"));
      assert.deepEqual(harness.model, ASTRA, "untrusted project config must not enable auto routing");
    },
  );
});

test("a launch-time PI_ROUTER_MODE wins over persisted session state", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      harness.branch.push({ type: "custom", customType: "pi-router-state", data: { mode: "auto", manualOverride: false } });
      harness.model = ASTRA;
      process.env.PI_ROUTER_MODE = "observe";
      await harness.start();
      await harness.turn("do the work");

      assert.equal(harness.fetchCalls.length, 1, "observe still classifies");
      assert.deepEqual(harness.model, ASTRA, "the environment mode must override saved auto mode");
    },
  );
});

test("restores persisted auto mode when no environment override is set", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig({ ...THREE_PROFILES, mode: "off" });
      harness.branch.push({ type: "custom", customType: "pi-router-state", data: { mode: "auto", manualOverride: false } });
      harness.model = ASTRA;
      await harness.start();
      await harness.turn("do the work");

      assert.deepEqual(harness.model, DEEPSEEK, "the persisted auto mode should be restored");
    },
  );
});

test("holds a marginal downgrade at the current profile", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.9, substantial: 0.7, strategic: 0.6 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      harness.model = ASTRA;
      harness.thinking = "high";
      await harness.turn("first");

      assert.deepEqual(harness.model, ASTRA, "a marginal downgrade should be held");
      assert.equal(harness.thinking, "high");
    },
  );
});

test("allows a confident downgrade", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.99, substantial: 0.7, strategic: 0.6 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      harness.model = ASTRA;
      harness.thinking = "high";
      await harness.turn("first");

      assert.deepEqual(harness.model, DEEPSEEK);
      assert.equal(harness.thinking, "low");
    },
  );
});

test("upgrades immediately", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.4, substantial: 0.4, strategic: 0.9 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      harness.model = DEEPSEEK;
      harness.thinking = "low";
      await harness.turn("hard task");

      assert.deepEqual(harness.model, ASTRA);
      assert.equal(harness.thinking, "high");
    },
  );
});

test("fails open when Jev cannot answer", async () => {
  await withHarness({ models: [DEEPSEEK, ASTRA], respond: () => ({ answers: {} }) }, async (harness) => {
    harness.writeProjectConfig(THREE_PROFILES);
    await harness.start();
    harness.model = ASTRA;
    harness.thinking = "high";
    await harness.turn("do the work");

    assert.deepEqual(harness.model, ASTRA, "the current model must survive classifier failure");
    assert.match(harness.notifications.at(-1)?.message ?? "", /pi-router skipped/);
  });
});

test("reuses Pi's OpenRouter credential before the environment variable", async () => {
  await withHarness(
    { models: [DEEPSEEK], providerApiKey: "pi-key", respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("do the work");

      assert.equal(harness.fetchCalls[0].authorization, "Bearer pi-key");
    },
  );
});

test("falls back to the configured environment variable for Jev auth", async () => {
  await withHarness(
    { models: [DEEPSEEK], providerApiKey: undefined, envApiKey: "env-key", respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      await harness.start();
      await harness.turn("do the work");

      assert.equal(harness.fetchCalls[0].authorization, "Bearer env-key");
    },
  );
});

test("a manual override during classification wins over the router", async () => {
  let harness!: Harness;
  harness = new Harness({
    models: [DEEPSEEK, ASTRA],
    providerApiKey: "test-key",
    respond: (body) => {
      harness.selectThinking("high");
      const questions = body.questions as Record<string, unknown>;
      return answers(Object.fromEntries(Object.keys(questions).map((id) => [id, id === "routine" ? 0.99 : 0.1])));
    },
  });
  try {
    harness.writeProjectConfig(THREE_PROFILES);
    harness.model = ASTRA;
    harness.thinking = "low";
    await harness.start();
    await harness.turn("do the work");

    assert.deepEqual(harness.model, ASTRA, "the override must not be overwritten");
    assert.equal(harness.thinking, "high");
  } finally {
    harness.dispose();
  }
});

test("PI_ROUTER_MODE overrides the configured mode", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      harness.model = ASTRA;
      process.env.PI_ROUTER_MODE = "observe";
      await harness.start();
      await harness.turn("do the work");

      assert.equal(harness.fetchCalls.length, 1, "observe mode still classifies");
      assert.deepEqual(harness.model, ASTRA, "observe mode must not switch models");
    },
  );
});

test("PI_ROUTER_OFF disables routing entirely", async () => {
  await withHarness(
    { models: [DEEPSEEK, ASTRA], respond: responder({ routine: 0.95 }) },
    async (harness) => {
      harness.writeProjectConfig(THREE_PROFILES);
      harness.model = ASTRA;
      process.env.PI_ROUTER_OFF = "1";
      await harness.start();
      await harness.turn("do the work");

      assert.equal(harness.fetchCalls.length, 0);
      assert.deepEqual(harness.model, ASTRA);
    },
  );
});
