import { existsSync, readFileSync } from "node:fs";
import type { ModelTarget, RouteName, RouterConfig, RouterMode, ThinkingLevel } from "./types.ts";
import { ROUTES, THINKING_LEVELS } from "./types.ts";

export const DEFAULT_CONFIG: RouterConfig = {
  mode: "observe",
  jev: {
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    apiKeyEnv: "OPENROUTER_API_KEY",
    timeoutMs: 4000,
    maxPromptChars: 12000,
    maxHistoryChars: 5000,
    zeroDataRetention: true,
  },
  thresholds: {
    expertProbability: 0.5,
    expertReasoningDepth: 2.25,
    fastProbability: 0.85,
    fastMaxExpertProbability: 0.15,
    fastMaxReasoningDepth: 0.8,
    expertDowngradeMaxProbability: 0.15,
    expertDowngradeMaxReasoningDepth: 1.75,
  },
  routes: {
    fast: [
      { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "low" },
      { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "low" },
    ],
    capable: [
      { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" },
      { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "high" },
    ],
    expert: [
      { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "high" },
      { provider: "openai", model: "gpt-6-astra", thinkingLevel: "high" },
      { provider: "openrouter", model: "openai/gpt-6-astra", thinkingLevel: "high" },
    ],
  },
};

type PartialConfig = Partial<Omit<RouterConfig, "jev" | "thresholds" | "routes">> & {
  jev?: Partial<RouterConfig["jev"]>;
  thresholds?: Partial<RouterConfig["thresholds"]>;
  routes?: Partial<Record<RouteName, ModelTarget[]>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseMode(value: unknown, fallback: RouterMode): RouterMode {
  return value === "observe" || value === "auto" || value === "off" ? value : fallback;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function parseTarget(value: unknown): ModelTarget | undefined {
  if (!isRecord(value)) return undefined;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const thinkingLevel = parseThinkingLevel(value.thinkingLevel);
  if (!provider || !model || !thinkingLevel) return undefined;
  return { provider, model, thinkingLevel };
}

function normalizePartial(value: unknown, source: string): PartialConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);

  const result: PartialConfig = {};
  if (value.mode !== undefined) {
    const mode = parseMode(value.mode, "observe");
    if (mode !== value.mode) throw new Error(`${source}: mode must be observe, auto, or off`);
    result.mode = mode;
  }

  if (value.jev !== undefined) {
    if (!isRecord(value.jev)) throw new Error(`${source}: jev must be an object`);
    result.jev = {};
    const strings = ["endpoint", "model", "apiKeyEnv"] as const;
    for (const key of strings) {
      const raw = value.jev[key];
      if (raw !== undefined) {
        if (typeof raw !== "string" || !raw.trim()) throw new Error(`${source}: jev.${key} must be a non-empty string`);
        result.jev[key] = raw.trim();
      }
    }
    const integers = ["timeoutMs", "maxPromptChars", "maxHistoryChars"] as const;
    for (const key of integers) {
      const raw = value.jev[key];
      if (raw !== undefined) {
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
          throw new Error(`${source}: jev.${key} must be a positive number`);
        }
        result.jev[key] = Math.floor(raw);
      }
    }
    if (value.jev.zeroDataRetention !== undefined) {
      if (typeof value.jev.zeroDataRetention !== "boolean") {
        throw new Error(`${source}: jev.zeroDataRetention must be boolean`);
      }
      result.jev.zeroDataRetention = value.jev.zeroDataRetention;
    }
  }

  if (value.thresholds !== undefined) {
    if (!isRecord(value.thresholds)) throw new Error(`${source}: thresholds must be an object`);
    result.thresholds = {};
    for (const key of Object.keys(DEFAULT_CONFIG.thresholds) as (keyof RouterConfig["thresholds"])[]) {
      const raw = value.thresholds[key];
      if (raw === undefined) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`${source}: thresholds.${key} must be a number`);
      }
      const isDepth = key.includes("ReasoningDepth");
      if (isDepth ? raw < 0 || raw > 3 : raw < 0 || raw > 1) {
        throw new Error(`${source}: thresholds.${key} is out of range`);
      }
      result.thresholds[key] = raw;
    }
  }

  if (value.routes !== undefined) {
    if (!isRecord(value.routes)) throw new Error(`${source}: routes must be an object`);
    result.routes = {};
    for (const route of ROUTES) {
      const raw = value.routes[route];
      if (raw === undefined) continue;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${source}: routes.${route} must be a non-empty array`);
      const parsed = raw.map(parseTarget);
      if (parsed.some((target) => target === undefined)) {
        throw new Error(`${source}: routes.${route} contains an invalid target`);
      }
      result.routes[route] = parsed as ModelTarget[];
    }
  }

  return result;
}

function merge(base: RouterConfig, patch: PartialConfig): RouterConfig {
  return {
    mode: patch.mode ?? base.mode,
    jev: { ...base.jev, ...patch.jev },
    thresholds: { ...base.thresholds, ...patch.thresholds },
    routes: {
      fast: patch.routes?.fast ?? base.routes.fast,
      capable: patch.routes?.capable ?? base.routes.capable,
      expert: patch.routes?.expert ?? base.routes.expert,
    },
  };
}

export interface LoadConfigOptions {
  globalPath?: string;
  projectPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): RouterConfig {
  let config = structuredClone(DEFAULT_CONFIG);
  if (options.globalPath && existsSync(options.globalPath)) {
    config = merge(config, normalizePartial(readJson(options.globalPath), options.globalPath));
  }
  if (options.projectPath && existsSync(options.projectPath)) {
    config = merge(config, normalizePartial(readJson(options.projectPath), options.projectPath));
  }

  const env = options.env ?? process.env;
  if (env.PI_ROUTER_MODE) config.mode = parseMode(env.PI_ROUTER_MODE, config.mode);
  if (env.PI_ROUTER_OFF === "1") config.mode = "off";
  return config;
}
