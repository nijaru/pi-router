# pi-router

A Pi extension that uses TypeSafe Jev to choose the model and thinking level for each user turn.

It is intentionally narrow: Jev judges whether each configured capability profile is sufficient for the request, ordinary code picks the cheapest profile that clears a probability threshold, and Pi switches before the agent starts. The router fails open: if Jev or a configured model is unavailable, the current Pi model remains in use.

## Current status

Experimental and paused. Routing quality has not been validated against a fixed-model baseline; the implementation and tests are retained, but further development and calibration are on hold.

The default mode is **observe**, which records recommendations without switching models. Observe mode still sends request context to Jev and adds classification latency. Leave the extension uninstalled or use `/router off` when not evaluating it.

Routing is driven by an ordered list of **profiles**. Each profile is one capability/cost choice with a routing description and one or more equivalent model targets. Order means: most preferred / cheapest when sufficient first, safest fallback last. The list is replaceable, so Muse, GLM, Qwen, or future models can be added without changing the router.

The default profiles are:

| Profile | Default target | Scope |
| --- | --- | --- |
| `routine` | DeepSeek V4.1 Flash, low thinking | Direct questions, routine edits, small/local implementation, straightforward debugging |
| `substantial` | DeepSeek V4.1 Flash, high thinking | Substantial but bounded coding, multi-step implementation, ordinary refactors/debugging |
| `strategic` | GPT-6 Astra, high thinking | Architecture/system design, subtle cross-cutting debugging, novel or ambiguous problems, consequential tradeoffs |

## Requirements

- Pi 0.86.0 or newer (tested against 0.86.1 and 0.87.0)
- Node.js 22.19+
- OpenRouter configured in Pi, or `OPENROUTER_API_KEY`, with access to `typesafe/jev-1.13`

```sh
# Reuses Pi's OpenRouter credential when available. Otherwise:
export OPENROUTER_API_KEY=...
pi install /absolute/path/to/pi-router
```

The Jev request uses OpenRouter's Decisions endpoint, not Chat Completions. By default the request asks OpenRouter for zero-data-retention/no-data-collection routing.

## Usage

```text
/router observe   classify and record decisions, but never switch
/router auto      classify and switch automatically
/router off       disable routing
/router status    show mode and the last decision
```

A manual `/model` selection, model cycle, or thinking-level change suspends automatic routing for the session. Run `/router auto` to resume automatic selection. Model and thinking changes the router itself makes do not count as manual overrides.

## How routing works

Before each user turn the router:

1. filters the configured profiles down to those with at least one model actually available in Pi, choosing the first available target in configured order;
2. asks Jev, in one Decisions request, one independent sufficiency question per remaining profile ("is this profile sufficient to complete the request reliably and without material quality loss?"), including each profile's routing description;
3. selects the first profile whose sufficiency probability reaches `sufficientProbability`, or the last (safest) available profile if none do.

Jev is not told the profile order, the profile pricing, or the currently selected model.

Upgrades take effect immediately. Moving to a cheaper profile than the current one is a downgrade and requires the stronger `downgradeProbability`, so a session does not flap between models on marginal evidence.

Short follow-ups such as `continue` include a compact recent conversation excerpt. The full transcript is never sent to Jev.

Decisions are stored as Pi custom session entries without raw prompt text so observe-mode behavior can be reviewed alongside the transcript.

## Configuration

Global config: `~/.pi/agent/pi-router.json`

Project override: `.pi/pi-router.json`, honored only when Pi trusts the project. Because a project config can redirect the Jev endpoint or select an API-key environment variable, it is ignored in untrusted checkouts.

Example:

```json
{
  "mode": "observe",
  "thresholds": {
    "sufficientProbability": 0.8,
    "downgradeProbability": 0.95
  },
  "profiles": [
    {
      "id": "routine",
      "description": "Direct questions, routine edits, small or local implementation, and straightforward debugging.",
      "targets": [
        { "provider": "deepseek", "model": "deepseek-flash", "thinkingLevel": "low" },
        { "provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash", "thinkingLevel": "low" }
      ]
    },
    {
      "id": "substantial",
      "description": "Substantial but bounded coding, multi-step implementation, and ordinary refactors or debugging needing sustained reasoning.",
      "targets": [
        { "provider": "deepseek", "model": "deepseek-flash", "thinkingLevel": "high" }
      ]
    },
    {
      "id": "strategic",
      "description": "Architecture and system design, subtle cross-cutting debugging, novel or ambiguous problems, and consequential tradeoffs.",
      "targets": [
        { "provider": "openai-codex", "model": "gpt-6-astra", "thinkingLevel": "high" }
      ]
    }
  ]
}
```

Rules:

- `profiles` is ordered from most preferred to safest fallback and replaces any lower-precedence list wholesale.
- Profile `id`s must be unique stable identifiers; `description` is routing policy, not marketing copy.
- Profile targets are tried in order and the first one available in Pi is used.
- `downgradeProbability` must be greater than or equal to `sufficientProbability`.

The Jev transport can also be changed without changing routing policy:

```json
{
  "jev": {
    "endpoint": "https://openrouter.ai/api/alpha/decisions",
    "model": "typesafe/jev-1.13",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "zeroDataRetention": true
  }
}
```

`PI_ROUTER_MODE=observe|auto|off` overrides both the configured mode and the mode persisted in a resumed session. `PI_ROUTER_OFF=1` forces it off and takes precedence over everything else.

## Development

```sh
npm install
npm test
npm run check
```

The first meaningful evaluation target is the false-downgrade rate over roughly 100–200 representative real Pi turns, not the percentage of turns pushed onto the cheap model.
