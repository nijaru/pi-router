# pi-router agent guidance

pi-router is a small Pi extension whose only product job is selecting the model and thinking level for each user turn. Jev is the current classifier backend, not the product boundary.

## Constraints

- Target current Pi extension APIs (0.86.x+) and keep Pi-specific integration thin.
- Routing is an ordered, user-configurable list of capability profiles. Do not reintroduce a fixed fast/capable/expert enum or hard-code DeepSeek/Astra into the router.
- Ordinary code owns route policy. Jev supplies bounded per-profile sufficiency probabilities only.
- Filter profiles to models actually available in Pi before asking Jev; within a profile, use the first available target in configured order.
- Honor `.pi/pi-router.json` only when Pi trusts the project; it can redirect the Jev endpoint or select a credential env var.
- Distinguish router-originated Pi model/thinking events from user changes without relying on timing: Pi does not await thinking-level event dispatch.
- Bias against false downgrades: upgrades are immediate, downgrades require a stronger threshold. Router failure must never block a Pi turn.
- Do not disclose profile order, pricing, or the current model in Jev requests.
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
