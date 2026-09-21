export const ROUTES = ["fast", "capable", "expert"] as const;
export type RouteName = (typeof ROUTES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type RouterMode = "observe" | "auto" | "off";

export interface ModelTarget {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
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
  expertProbability: number;
  expertReasoningDepth: number;
  fastProbability: number;
  fastMaxExpertProbability: number;
  fastMaxReasoningDepth: number;
  expertDowngradeMaxProbability: number;
  expertDowngradeMaxReasoningDepth: number;
}

export interface RouterConfig {
  mode: RouterMode;
  jev: JevConfig;
  thresholds: RouterThresholds;
  routes: Record<RouteName, ModelTarget[]>;
}

export interface RouteAnalysis {
  lowEffortSufficient: number;
  expertMateriallyBetter: number;
  reasoningDepth: number;
  latencyMs: number;
  model?: string;
  usage?: {
    inputTokens?: number;
    cost?: number;
  };
}

export interface RouteDecision {
  desired: RouteName;
  selected: RouteName;
  held: boolean;
  reason: string;
}
