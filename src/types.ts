export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type RouterMode = "observe" | "auto" | "off";

/** One provider/model/thinking-level choice that satisfies a routing profile. */
export interface ModelTarget {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * One capability/cost choice the router may select.
 *
 * Profiles are ordered from the most preferred (cheapest when sufficient)
 * first to the safest fallback last. `description` is routing policy: it tells
 * the classifier what class of work this profile reliably covers, not what the
 * underlying model is. `targets` are equivalent ways to realize the profile,
 * tried in order against the models actually available in Pi.
 */
export interface RoutingProfile {
  /** Stable identifier used in configuration, decisions, and telemetry. */
  id: string;
  /** Routing policy: the work this profile reliably covers. */
  description: string;
  /** Equivalent targets; the first one available in Pi is used. */
  targets: ModelTarget[];
}

export interface JevConfig {
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
  maxPromptChars: number;
  maxHistoryChars: number;
  zeroDataRetention: boolean;
}

export interface RouterThresholds {
  /** Minimum sufficiency probability for a profile to be selected. */
  sufficientProbability: number;
  /** Stronger probability required to move to a cheaper profile than the current one. */
  downgradeProbability: number;
}

export interface RouterConfig {
  mode: RouterMode;
  jev: JevConfig;
  thresholds: RouterThresholds;
  /** Ordered capability/cost choices, most preferred first. */
  profiles: RoutingProfile[];
}

/** Jev's sufficiency estimate for one routing profile. */
export interface ProfileAssessment {
  id: string;
  probability: number;
}

export interface RouteAnalysis {
  profiles: ProfileAssessment[];
  latencyMs: number;
  model?: string;
  usage?: {
    inputTokens?: number;
    cost?: number;
  };
}

/** Deterministic policy outcome, expressed in profile ids. */
export interface RouteDecision {
  /** First profile at or above the sufficiency threshold, else the safest fallback. */
  desired: string;
  /** Profile actually used; differs from `desired` when a downgrade is held. */
  selected: string;
  held: boolean;
  reason: string;
}
