import test from "node:test";
import assert from "node:assert/strict";
import { recentConversationContext } from "../src/context.ts";

test("keeps recent user and assistant context", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "redesign the router" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I changed the policy." }] } },
  ];
  const result = recentConversationContext(branch, 5000);
  assert.match(result ?? "", /redesign the router/);
  assert.match(result ?? "", /I changed the policy/);
});

test("preserves an earlier identical prompt", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "review the patch" } },
    { type: "message", message: { role: "assistant", content: "done" } },
  ];
  const result = recentConversationContext(branch, 5000);
  assert.match(result ?? "", /review the patch/);
});

test("returns undefined when there is no usable context or no budget", () => {
  const branch = [{ type: "message", message: { role: "user", content: "hi" } }];
  assert.equal(recentConversationContext([], 5000), undefined);
  assert.equal(recentConversationContext(branch, 0), undefined);
});
