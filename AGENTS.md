# pi-router agent guidance

pi-router is a small Pi extension whose only product job is selecting the model and thinking level for each user turn. Jev is the current classifier backend, not the product boundary.

## Constraints

- Target current Pi extension APIs (0.86.x+) and keep Pi-specific integration thin.
- Keep routing semantics capability/cost based; do not hard-code DeepSeek/Astra into Jev questions.
- Ordinary code owns route policy. Jev supplies bounded semantic judgments only.
- Bias against false downgrades. Router failure must never block a Pi turn.
- Manual model/thinking selection is authoritative until the user returns to `/router auto` or `/router observe`.
- Do not expand v1 into skill routing, tool policing, retrieval, worker orchestration, generic Jev middleware, or budget management without evidence from real routing use.
- Do not log API keys or raw prompt/transcript content in telemetry.

## Verification

Run:

```sh
npm test
npm run check
```

Real acceptance also requires installing the checkout into Pi and exercising observe mode before enabling automatic routing broadly.
