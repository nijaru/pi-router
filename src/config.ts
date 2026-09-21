import { existsSync, readFileSync } from "node:fs";
import type {
  JevConfig,
  ModelTarget,
  RouterConfig,
  RouterMode,
  RouterThresholds,
  RoutingProfile,
  ThinkingLevel,
} from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";

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
    sufficientProbability: 0.8,
    downgradeProbability: 0.95,
  },
  profiles: [
    {
      id: "routine",
      description:
        "Direct questions, routine edits, small or local implementation, and straightforward debugging: " +
        "bounded work with one clear path and little sustained reasoning.",
      targets: [
        { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "low" },
        { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "low" },
      ],
    },
    {
      id: "substantial",
      description:
        "Substantial but bounded coding, multi-step implementation, and ordinary refactors or debugging that need " +
        "sustained reasoning over familiar patterns.",
      targets: [
        { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" },
        { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "high" },
      ],
    },
    {
      id: "strategic",
      description:
        "Architecture and system design, subtle cross-cutting debugging, novel or ambiguous problems, and decisions " +
        "with consequential tradeoffs.",
      targets: [
        { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "high" },
        { provider: "openai", model: "gpt-6-astra", thinkingLevel: "high" },
        { provider: "openrouter", model: "openai/gpt-6-astra", thinkingLevel: "high" },
      ],
    },
  ],
};

type PartialConfig = {
  mode?: RouterMode;
  jev?: Partial<JevConfig>;
  thresholds?: Partial<RouterThresholds>;
  profiles?: RoutingProfile[];
};

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function parseProfiles(value: unknown, source: string): RoutingProfile[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${source}: profiles must be a non-empty array`);
  const seen = new Set<string>();
  const profiles: RoutingProfile[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) throw new Error(`${source}: profiles[${index}] must be an object`);

    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(`${source}: profiles[${index}].id must be a stable identifier (letters, digits, . _ -)`);
    }
    if (seen.has(id)) throw new Error(`${source}: duplicate profile id "${id}"`);
    seen.add(id);

    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!description) throw new Error(`${source}: profiles[${index}].description must be a non-empty string`);

    if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
      throw new Error(`${source}: profiles[${index}].targets must be a non-empty array`);
    }
    const targets = raw.targets.map(parseTarget);
    if (targets.some((target) => target === undefined)) {
      throw new Error(`${source}: profiles[${index}].targets contains an invalid target`);
    }

    profiles.push({ id, description, targets: targets as ModelTarget[] });
  }
  return profiles;
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
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
          throw new Error(`${source}: jev.${key} must be a positive integer`);
        }
        result.jev[key] = raw;
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
    for (const key of Object.keys(value.thresholds)) {
      if (!Object.hasOwn(DEFAULT_CONFIG.thresholds, key)) throw new Error(`${source}: unknown threshold "${key}"`);
    }
    for (const key of Object.keys(DEFAULT_CONFIG.thresholds) as (keyof RouterThresholds)[]) {
      const raw = value.thresholds[key];
      if (raw === undefined) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`${source}: thresholds.${key} must be a number`);
      }
      if (raw < 0 || raw > 1) throw new Error(`${source}: thresholds.${key} must be between 0 and 1`);
      result.thresholds[key] = raw;
    }
  }

  if (value.profiles !== undefined) {
    result.profiles = parseProfiles(value.profiles, source);
  }

  return result;
}

function merge(base: RouterConfig, patch: PartialConfig): RouterConfig {
  return {
    mode: patch.mode ?? base.mode,
    jev: { ...base.jev, ...patch.jev },
    thresholds: { ...base.thresholds, ...patch.thresholds },
    profiles: patch.profiles ?? base.profiles,
  };
}

function assertThresholdOrder(config: RouterConfig): void {
  const { sufficientProbability, downgradeProbability } = config.thresholds;
  if (downgradeProbability < sufficientProbability) {
    throw new Error(
      `pi-router config: thresholds.downgradeProbability (${downgradeProbability}) must be >= ` +
        `thresholds.sufficientProbability (${sufficientProbability})`,
    );
  }
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

  assertThresholdOrder(config);
  return config;
}
