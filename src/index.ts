import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { recentConversationContext } from "./context.ts";
import { classifyWithJev } from "./jev.ts";
import { chooseRoute } from "./policy.ts";
import type { ModelTarget, RouteAnalysis, RouteDecision, RouteName, RouterConfig, RouterMode } from "./types.ts";
import { ROUTES } from "./types.ts";

type AnyModel = {
  provider: string;
  id: string;
};

interface PersistedState {
  mode: RouterMode;
  manualOverride: boolean;
}

interface LastDecision {
  analysis: RouteAnalysis;
  decision: RouteDecision;
  target?: ModelTarget;
  applied: boolean;
  error?: string;
}

function modelKey(model: AnyModel | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function sameModel(model: AnyModel | undefined, target: ModelTarget): boolean {
  return !!model && model.provider === target.provider && model.id === target.model;
}

function currentRoute(config: RouterConfig, model: AnyModel | undefined, thinkingLevel: string): RouteName | undefined {
  if (!model) return undefined;
  for (const route of ROUTES) {
    if (config.routes[route].some((target) => sameModel(model, target) && target.thinkingLevel === thinkingLevel)) {
      return route;
    }
  }
  return undefined;
}

function availableModels(ctx: ExtensionContext): AnyModel[] {
  if (ctx.scopedModels.length > 0) return ctx.scopedModels.map((entry) => entry.model);
  return ctx.modelRegistry.getAvailable();
}

function chooseTarget(config: RouterConfig, route: RouteName, ctx: ExtensionContext): ModelTarget | undefined {
  const available = availableModels(ctx);
  return config.routes[route].find((target) =>
    available.some((model) => model.provider === target.provider && model.id === target.model),
  );
}

function formatDecision(last: LastDecision | undefined): string {
  if (!last) return "no decision yet";
  if (last.error) return `error: ${last.error}`;
  const target = last.target ? `${last.target.provider}/${last.target.model}:${last.target.thinkingLevel}` : "no available target";
  return `${last.decision.selected} (${last.decision.reason}) → ${target}${last.applied ? " [applied]" : ""}`;
}

export default function piRouter(pi: ExtensionAPI) {
  let config = structuredClone(loadConfig());
  let mode: RouterMode = config.mode;
  let manualOverride = false;
  let applyingRoute = false;
  let expectedModelSelection: string | undefined;
  let expectedThinkingSelection: string | undefined;
  let lastDecision: LastDecision | undefined;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const suffix = manualOverride ? ":manual" : lastDecision?.decision.selected ? `:${lastDecision.decision.selected}` : "";
    ctx.ui.setStatus("pi-router", mode === "off" ? "router:off" : `router:${mode}${suffix}`);
  }

  function persistState() {
    pi.appendEntry("pi-router-state", { mode, manualOverride } satisfies PersistedState);
  }

  function recordDecision() {
    if (!lastDecision || lastDecision.error) return;
    pi.appendEntry("pi-router-decision", {
      mode,
      desired: lastDecision.decision.desired,
      selected: lastDecision.decision.selected,
      held: lastDecision.decision.held,
      target: lastDecision.target,
      applied: lastDecision.applied,
      analysis: {
        lowEffortSufficient: lastDecision.analysis.lowEffortSufficient,
        expertMateriallyBetter: lastDecision.analysis.expertMateriallyBetter,
        reasoningDepth: lastDecision.analysis.reasoningDepth,
        latencyMs: lastDecision.analysis.latencyMs,
        model: lastDecision.analysis.model,
        usage: lastDecision.analysis.usage,
      },
    });
  }

  async function applyTarget(target: ModelTarget, ctx: ExtensionContext): Promise<boolean> {
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) return false;
    applyingRoute = true;
    try {
      if (!sameModel(ctx.model, target)) {
        expectedModelSelection = `${target.provider}/${target.model}`;
        const switched = await pi.setModel(model);
        if (!switched) {
          expectedModelSelection = undefined;
          return false;
        }
      }
      if (pi.getThinkingLevel() !== target.thinkingLevel) {
        expectedThinkingSelection = target.thinkingLevel;
        pi.setThinkingLevel(target.thinkingLevel);
      }
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

  async function classify(prompt: string, ctx: ExtensionContext): Promise<{ analysis: RouteAnalysis; decision: RouteDecision }> {
    const apiKey = await resolveJevApiKey(ctx);
    const history = recentConversationContext(ctx.sessionManager.getBranch(), prompt, config.jev.maxHistoryChars);
    const analysis = await classifyWithJev(
      {
        prompt,
        history,
        project: basename(ctx.cwd),
        currentModel: modelKey(ctx.model),
        currentThinking: pi.getThinkingLevel(),
      },
      config.jev,
      apiKey,
    );
    const decision = chooseRoute(analysis, config.thresholds, currentRoute(config, ctx.model, pi.getThinkingLevel()));
    return { analysis, decision };
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig({
        globalPath: join(getAgentDir(), "pi-router.json"),
        projectPath: join(ctx.cwd, CONFIG_DIR_NAME, "pi-router.json"),
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
    if (saved?.data?.mode === "observe" || saved?.data?.mode === "auto" || saved?.data?.mode === "off") mode = saved.data.mode;
    manualOverride = saved?.data?.manualOverride === true;
    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (expectedModelSelection === selected) {
      expectedModelSelection = undefined;
      return;
    }
    if (applyingRoute || event.source === "restore") return;
    manualOverride = true;
    persistState();
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (expectedThinkingSelection === event.level) {
      expectedThinkingSelection = undefined;
      return;
    }
    if (applyingRoute) return;
    manualOverride = true;
    persistState();
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (mode === "off" || (mode === "auto" && manualOverride)) return;

    try {
      const { analysis, decision } = await classify(event.prompt, ctx);
      const target = chooseTarget(config, decision.selected, ctx);
      let applied = false;

      if (mode === "auto" && target) {
        applied = await applyTarget(target, ctx);
        if (!applied) notify(ctx, `pi-router could not activate ${target.provider}/${target.model}; keeping ${modelKey(ctx.model) ?? "current model"}`, "warning");
      }

      lastDecision = { analysis, decision, target, applied };
      recordDecision();
      updateStatus(ctx);

      if (mode === "observe") {
        notify(ctx, `router observe → ${decision.selected}${target ? ` · ${target.provider}/${target.model}:${target.thinkingLevel}` : " · no available target"}`);
      } else if (applied && target) {
        notify(ctx, `router → ${decision.selected} · ${target.provider}/${target.model}:${target.thinkingLevel}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastDecision = {
        analysis: { lowEffortSufficient: 0, expertMateriallyBetter: 0, reasoningDepth: 0, latencyMs: 0 },
        decision: { desired: "capable", selected: "capable", held: false, reason: "classification failed" },
        applied: false,
        error: message,
      };
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
