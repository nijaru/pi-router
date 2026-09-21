import type { ProfileAssessment, RouteDecision, RouterThresholds } from "./types.ts";

/**
 * Select a routing profile from Jev's per-profile sufficiency estimates.
 *
 * `assessments` arrive in configured preference order (most preferred/cheapest
 * first, safest fallback last). The first profile whose probability clears
 * `sufficientProbability` is desired; when none clears it, the last (safest)
 * profile is used instead.
 *
 * Upgrades take effect immediately. A move to a cheaper profile than the
 * current one is a downgrade and requires the stronger `downgradeProbability`
 * to avoid model/cache flapping on marginal evidence.
 */
export function chooseProfile(
  assessments: readonly ProfileAssessment[],
  thresholds: RouterThresholds,
  currentId?: string,
): RouteDecision {
  if (assessments.length === 0) throw new Error("no profiles to choose from");

  const currentIndex = currentId === undefined ? -1 : assessments.findIndex((entry) => entry.id === currentId);

  let desiredIndex = assessments.findIndex((entry) => entry.probability >= thresholds.sufficientProbability);
  const fallback = desiredIndex === -1;
  if (fallback) desiredIndex = assessments.length - 1;

  let selectedIndex = desiredIndex;
  let held = false;
  if (currentIndex !== -1 && desiredIndex < currentIndex) {
    if (assessments[desiredIndex].probability >= thresholds.downgradeProbability) {
      selectedIndex = desiredIndex;
    } else {
      selectedIndex = currentIndex;
      held = true;
    }
  }

  const summary = assessments.map((entry) => `${entry.id}=${entry.probability.toFixed(2)}`).join(" ");
  const notes: string[] = [];
  if (fallback) notes.push("no profile cleared the sufficiency threshold; using the safest fallback");
  if (held) notes.push("held to avoid a marginal downgrade");

  return {
    desired: assessments[desiredIndex].id,
    selected: assessments[selectedIndex].id,
    held,
    reason: notes.length > 0 ? `${summary} · ${notes.join("; ")}` : summary,
  };
}
