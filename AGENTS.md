# pi-router

Jev-backed per-turn model/thinking router for Pi. Narrow scope: choose the configured
model + thinking-level profile sufficient for the current turn, and fail open
whenever anything is uncertain.

## Commands

- `npm test` — `node --experimental-strip-types --test test/*.test.ts`
- `npm run check` — `tsc --noEmit`
- CI (`.github/workflows/check.yml`) runs both against the oldest supported and the
  current Pi releases; update the matrix when a new Pi minor matters.

## Invariants

- Fail open: Jev, config, and model failures never block or alter a Pi turn.
- Observe is the default mode; automatic switching requires `/router auto`.
- Jev sees only the request and a compact recent-context excerpt: never the current
  model, profile order, pricing, or raw transcript. No raw prompt text in telemetry.
- Manual model/thinking changes suspend routing; router-originated changes must not
  register as manual overrides.
- One Decisions request per turn, one independent sufficiency question per available
  profile; profiles are filtered to available Pi models before classification.
- Selection is deterministic: first profile at/above `sufficientProbability`, else
  the safest fallback; downgrades need `downgradeProbability`.

## Discovery

- Behavior and configuration: `README.md`.
- Design rationale, decisions, and calibration records live in the maintainer's
  private knowledge base under the `pi-router` project, not in this repository.
