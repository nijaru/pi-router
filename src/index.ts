import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { recentConversationContext } from "./context.ts";
import { classifyWithJev } from "./jev.ts";
import { chooseProfile } from "./policy.ts";
import type {
  ModelTarget,
  RouteAnalysis,
  RouteDecision,
  RoutingProfile,
  RouterConfig,
  RouterMode,
  ThinkingLevel,
} from "./types.ts";

interface ModelLike {
  provider: string;
  id: string;
}

interface PersistedState {
  mode: RouterMode;
  manualOverride: boolean;
}

interface AvailableProfile {
  profile: RoutingProfile;
  target: ModelTarget;
}

interface LastDecision {
  analysis?: RouteAnalysis;
  decision?: RouteDecision;
  target?: ModelTarget;
  applied: boolean;
  error?: string;
}

interface RoutingOutcome {
  analysis: RouteAnalysis;
  decision: RouteDecision;
  target: ModelTarget;
}

function modelKey(model: ModelLike | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function sameModel(model: ModelLike | undefined, target: ModelTarget): boolean {
  return !!model && model.provider === target.provider && model.id === target.model;
}

function targetKey(target: ModelTarget): string {
  return `${target.provider}/${target.model}@${target.thinkingLevel}`;
}

function availableModels(ctx: ExtensionContext): readonly ModelLike[] {
  const available = ctx.modelRegistry.getAvailable();
  if (ctx.scopedModels.length === 0) return available;
  // Session scope is not itself an availability check: intersect it with the
  // models Pi can currently use so a stale scope cannot select a dead target.
  const keys = new Set(available.map((model) => `${model.provider}\0${model.id}`));
  return ctx.scopedModels.map((entry) => entry.model).filter((model) => keys.has(`${model.provider}\0${model.id}`));
}

/**
 * Keep only configured profiles with at least one model that actually exists in
 * Pi, choosing the first available target in configured order. This runs before
 * Jev so unavailable profiles are never classified and never fall back blindly.
 */
function availableProfiles(config: RouterConfig, ctx: ExtensionContext): AvailableProfile[] {
  const models = availableModels(ctx);
  const isAvailable = (target: ModelTarget) =>
    models.some((model) => model.provider === target.provider && model.id === target.model);

  const result: AvailableProfile[] = [];
  for (const profile of config.profiles) {
    const target = profile.targets.find(isAvailable);
    if (target) result.push({ profile, target });
  }
  return result;
}

function formatDecision(last: LastDecision | undefined): string {
  if (!last) return "no decision yet";
  if (last.error) return `error: ${last.error}`;
  const target = last.target ? `${last.target.provider}/${last.target.model}:${last.target.thinkingLevel}` : "no available target";
  const held = last.decision?.held ? " (held)" : "";
  const reason = last.decision ? ` [${last.decision.reason}]` : "";
  return `${last.decision?.selected ?? "?"}${held}${reason} → ${target}${last.applied ? " [applied]" : ""}`;
}

export default function piRouter(pi: ExtensionAPI) {
  let config = structuredClone(loadConfig());
  let mode: RouterMode = config.mode;
  let manualOverride = false;
  let applyingRoute = false;
  let lastDecision: LastDecision | undefined;
  // The effective thinking level the router last committed to, used to ignore
  // this extension's own (possibly delayed) Pi thinking events.
  let routerThinking: ThinkingLevel | undefined;
  // Effective (clamped) thinking level per configured target, so a target whose
  // level Pi clamps is still recognized as the current profile next turn.
  const effectiveThinking = new Map<string, ThinkingLevel>();

  function matchesCurrent(target: ModelTarget, model: ModelLike | undefined, thinking: ThinkingLevel): boolean {
    if (!sameModel(model, target)) return false;
    return target.thinkingLevel === thinking || effectiveThinking.get(targetKey(target)) === thinking;
  }

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const suffix = manualOverride ? ":manual" : lastDecision?.decision?.selected ? `:${lastDecision.decision.selected}` : "";
    ctx.ui.setStatus("pi-router", mode === "off" ? "router:off" : `router:${mode}${suffix}`);
  }

  function persistState() {
    pi.appendEntry("pi-router-state", { mode, manualOverride } satisfies PersistedState);
  }

  function recordDecision() {
    if (!lastDecision?.analysis || !lastDecision.decision || lastDecision.error) return;
    pi.appendEntry("pi-router-decision", {
      mode,
      desired: lastDecision.decision.desired,
      selected: lastDecision.decision.selected,
      held: lastDecision.decision.held,
      reason: lastDecision.decision.reason,
      target: lastDecision.target,
      applied: lastDecision.applied,
      profiles: lastDecision.analysis.profiles,
      latencyMs: lastDecision.analysis.latencyMs,
      model: lastDecision.analysis.model,
      usage: lastDecision.analysis.usage,
    });
  }

  async function applyTarget(target: ModelTarget, ctx: ExtensionContext): Promise<boolean> {
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) return false;

    applyingRoute = true;
    try {
      if (!sameModel(ctx.model, target)) {
        const switched = await pi.setModel(model);
        if (!switched) return false;
      }
      if (pi.getThinkingLevel() !== target.thinkingLevel) {
        pi.setThinkingLevel(target.thinkingLevel);
      }
      routerThinking = pi.getThinkingLevel();
      effectiveThinking.set(targetKey(target), routerThinking);
      return true;
    } finally {
      applyingRoute = false;
    }
  }

  async function resolveJevApiKey(ctx: ExtensionContext): Promise<string> {
    if (config.jev.endpoint.startsWith("https://openrouter.ai/")) {
      try {
        const resolved = await ctx.modelRegistry.getProviderAuth("openrouter");
        if (resolved?.auth.apiKey) return resolved.auth.apiKey;
      } catch {
        // Fall through to the explicit environment variable. Router failures must not block Pi.
      }
    }
    const apiKey = process.env[config.jev.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`no Jev API key: configure Pi's openrouter provider or set ${config.jev.apiKeyEnv}`);
    }
    return apiKey;
  }

  /** Returns undefined when no configured profile has an available model. */
  async function classifyRoute(prompt: string, ctx: ExtensionContext): Promise<RoutingOutcome | undefined> {
    const available = availableProfiles(config, ctx);
    if (available.length === 0) return undefined;

    const apiKey = await resolveJevApiKey(ctx);
    const thinking = pi.getThinkingLevel();
    const currentIndex = available.findIndex(({ profile }) =>
      profile.targets.some((target) => matchesCurrent(target, ctx.model, thinking)),
    );
    const history = recentConversationContext(ctx.sessionManager.getBranch(), config.jev.maxHistoryChars);

    const analysis = await classifyWithJev(
      {
        prompt,
        history,
        project: basename(ctx.cwd),
        profiles: available.map(({ profile }) => ({ id: profile.id, description: profile.description })),
      },
      config.jev,
      apiKey,
    );

    const decision = chooseProfile(
      analysis.profiles,
      config.thresholds,
      currentIndex === -1 ? undefined : available[currentIndex].profile.id,
    );
    const selected = available.find(({ profile }) => profile.id === decision.selected);
    if (!selected) throw new Error(`selected profile "${decision.selected}" is not available`);

    return { analysis, decision, target: selected.target };
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig({
        globalPath: join(getAgentDir(), "pi-router.json"),
        // Project configuration can redirect the Jev endpoint or select a
        // credential env var, so it is only honored when Pi trusts the project.
        projectPath: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "pi-router.json") : undefined,
      });
      mode = config.mode;
    } catch (error) {
      config = structuredClone(loadConfig());
      mode = config.mode;
      notify(ctx, `pi-router config error; using defaults: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }

    const saved = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-router-state")
      .pop() as { data?: Partial<PersistedState> } | undefined;
    if (saved?.data?.mode === "observe" || saved?.data?.mode === "auto" || saved?.data?.mode === "off") {
      mode = saved.data.mode;
    }
    manualOverride = saved?.data?.manualOverride === true;

    // A launch-time environment mode wins over persisted session state.
    const envMode = process.env.PI_ROUTER_MODE;
    if (envMode === "observe" || envMode === "auto" || envMode === "off") mode = envMode;
    if (process.env.PI_ROUTER_OFF === "1") mode = "off";
    updateStatus(ctx);
  });

  // Any Pi model/thinking change the router did not originate is a manual override.
  pi.on("model_select", async (event, ctx) => {
    if (applyingRoute || event.source === "restore") return;
    manualOverride = true;
    routerThinking = undefined;
    persistState();
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (applyingRoute) return;
    // Pi dispatches this event without awaiting it, and other extensions can
    // delay this handler past the end of an apply. Reject our own emission by
    // its committed level, and reject stale emissions whose state already moved on.
    if (event.level === routerThinking) return;
    if (event.level !== pi.getThinkingLevel()) return;
    manualOverride = true;
    routerThinking = undefined;
    persistState();
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (mode === "off" || (mode === "auto" && manualOverride)) return;

    try {
      const outcome = await classifyRoute(event.prompt, ctx);
      if (!outcome) {
        notify(ctx, "pi-router: no configured profile has an available model; keeping the current model", "warning");
        return;
      }

      let applied = false;
      // Re-check the override: a manual model/thinking change during the Jev
      // request must win over the decision we were already computing.
      if (mode === "auto" && !manualOverride) {
        applied = await applyTarget(outcome.target, ctx);
        if (!applied) {
          notify(
            ctx,
            `pi-router could not activate ${outcome.target.provider}/${outcome.target.model}; keeping ${modelKey(ctx.model) ?? "current model"}`,
            "warning",
          );
        }
      }

      lastDecision = { analysis: outcome.analysis, decision: outcome.decision, target: outcome.target, applied };
      recordDecision();
      updateStatus(ctx);

      if (mode === "observe") {
        const held = outcome.decision.held ? " (held)" : "";
        notify(
          ctx,
          `router observe → ${outcome.decision.selected}${held} · ${outcome.target.provider}/${outcome.target.model}:${outcome.target.thinkingLevel}`,
        );
      } else if (applied) {
        notify(ctx, `router → ${outcome.decision.selected} · ${outcome.target.provider}/${outcome.target.model}:${outcome.target.thinkingLevel}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastDecision = { applied: false, error: message };
      updateStatus(ctx);
      notify(ctx, `pi-router skipped: ${message}`, "warning");
    }
  });

  pi.registerCommand("router", {
    description: "Control automatic model routing: observe | auto | off | status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "status") {
        notify(ctx, `pi-router ${mode}${manualOverride ? " (manual override)" : ""}; ${formatDecision(lastDecision)}`);
        return;
      }
      if (process.env.PI_ROUTER_OFF === "1") {
        mode = "off";
        updateStatus(ctx);
        notify(ctx, "pi-router is forced off by PI_ROUTER_OFF=1", "warning");
        return;
      }
      if (command !== "observe" && command !== "auto" && command !== "off") {
        notify(ctx, "Usage: /router observe | auto | off | status", "warning");
        return;
      }
      mode = command;
      if (mode === "auto" || mode === "observe") manualOverride = false;
      persistState();
      updateStatus(ctx);
      notify(ctx, `pi-router ${mode}`);
    },
  });
}
