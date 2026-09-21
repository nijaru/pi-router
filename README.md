# pi-router

A Pi extension that uses TypeSafe Jev to choose the model and thinking level for each user turn.

It is intentionally narrow: Jev judges how much capability the request needs, ordinary code maps that judgment to one of three configurable routes, and Pi switches before the agent starts. The router fails open: if Jev or a configured model is unavailable, the current Pi model remains in use.

## Current status

Early v0. The default mode is **observe** so decisions can be calibrated on real sessions before automatic switching is trusted.

Default routes are:

| Route | Default target |
| --- | --- |
| `fast` | DeepSeek V4.1 Flash, low thinking |
| `capable` | DeepSeek V4.1 Flash, high thinking |
| `expert` | GPT-6 Astra, high thinking |

Each route has provider fallbacks and can be replaced in configuration.

## Requirements

- Pi 0.86.x or newer
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

A manual `/model` selection, model cycle, or thinking-level change suspends automatic routing for the session. Run `/router auto` to resume automatic selection.

## How routing works

One Jev request asks three bounded questions:

1. Is low-effort inference sufficient?
2. Would a top-tier model materially improve the outcome?
3. How much reasoning depth does the request require?

Deterministic policy maps those probabilities/scores to `fast`, `capable`, or `expert`. Upgrades happen immediately. Downgrading away from `expert` requires stronger evidence to reduce model flapping and avoid throwing away a valuable prompt cache for a marginal change.

Short follow-ups such as `continue` include a compact recent conversation excerpt. The full transcript is never sent to Jev.

Decisions are stored as Pi custom session entries without raw prompt text so observe-mode behavior can be reviewed alongside the transcript.

## Configuration

Global config: `~/.pi/agent/pi-router.json`

Project override: `.pi/pi-router.json`

Example:

```json
{
  "mode": "observe",
  "routes": {
    "fast": [
      { "provider": "deepseek", "model": "deepseek-flash", "thinkingLevel": "low" }
    ],
    "capable": [
      { "provider": "deepseek", "model": "deepseek-flash", "thinkingLevel": "high" }
    ],
    "expert": [
      { "provider": "openai-codex", "model": "gpt-6-astra", "thinkingLevel": "high" }
    ]
  }
}
```

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

`PI_ROUTER_MODE=observe|auto|off` overrides the configured mode. `PI_ROUTER_OFF=1` forces it off.

## Development

```sh
npm install
npm test
npm run check
```

The first meaningful evaluation target is the false-downgrade rate over roughly 100–200 representative real Pi turns, not the percentage of turns pushed onto the cheap model.
