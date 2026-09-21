import test from "node:test";
import assert from "node:assert/strict";
import { recentConversationContext } from "../src/context.ts";

test("keeps recent user/assistant context and skips duplicate current prompt", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "redesign the router" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I changed the policy." }] } },
    { type: "message", message: { role: "user", content: "continue" } },
  ];
  const result = recentConversationContext(branch, "continue", 5000);
  assert.match(result ?? "", /redesign the router/);
  assert.match(result ?? "", /I changed the policy/);
  assert.doesNotMatch(result ?? "", /user: continue/);
});
