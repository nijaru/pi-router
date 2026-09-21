import type { RouteAnalysis, RouteDecision, RouteName, RouterThresholds } from "./types.ts";

const RANK: Record<RouteName, number> = { fast: 0, capable: 1, expert: 2 };

export function chooseRoute(analysis: RouteAnalysis, thresholds: RouterThresholds, current?: RouteName): RouteDecision {
  let desired: RouteName;
  if (
    analysis.expertMateriallyBetter >= thresholds.expertProbability ||
    analysis.reasoningDepth >= thresholds.expertReasoningDepth
  ) {
    desired = "expert";
  } else if (
    analysis.lowEffortSufficient >= thresholds.fastProbability &&
    analysis.expertMateriallyBetter <= thresholds.fastMaxExpertProbability &&
    analysis.reasoningDepth <= thresholds.fastMaxReasoningDepth
  ) {
    desired = "fast";
  } else {
    desired = "capable";
  }

  let selected = desired;
  let held = false;
  let reason = `low=${analysis.lowEffortSufficient.toFixed(2)} expert=${analysis.expertMateriallyBetter.toFixed(2)} depth=${analysis.reasoningDepth.toFixed(2)}`;

  // The only expensive transition in the default setup is leaving the expert model.
  // Require strong evidence before downgrading; upgrades and fast<->capable thinking
  // changes are allowed immediately.
  if (current === "expert" && RANK[desired] < RANK.expert) {
    const safeToDowngrade =
      analysis.expertMateriallyBetter <= thresholds.expertDowngradeMaxProbability &&
      analysis.reasoningDepth <= thresholds.expertDowngradeMaxReasoningDepth;
    if (!safeToDowngrade) {
      selected = "expert";
      held = true;
      reason += " · held expert to avoid a marginal downgrade";
    }
  }

  return { desired, selected, held, reason };
}
