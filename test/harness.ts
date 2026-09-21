import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import piRouter from "../src/index.ts";

export interface FakeModel {
  provider: string;
  id: string;
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

export interface HarnessOptions {
  models: FakeModel[];
  providerApiKey?: string;
  /** Sets OPENROUTER_API_KEY for the lifetime of the harness. */
  envApiKey?: string;
  /** Session-scoped models; when omitted no --models scoping is active. */
  scopedModels?: FakeModel[];
  /** When false, project-local pi-router.json is ignored. */
  projectTrusted?: boolean;
  /** Supported thinking levels; unsupported requests are clamped like Pi does. */
  supportedThinking?: string[];
  /** Delay before router-originated thinking events reach the extension. */
  thinkingDispatchDelayMs?: number;
  respond?: (body: Record<string, unknown>, call: number) => unknown;
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Build a Decisions response answering each question key with a probability. */
export function answers(probabilities: Record<string, number>): Record<string, unknown> {
  const entries = Object.entries(probabilities).map(([id, probability]) => [id, { type: "noul", noul: probability }]);
  return { model: "typesafe/jev-1.13", answers: Object.fromEntries(entries) };
}

/**
 * A minimal fake of the Pi extension host: it records registered handlers,
 * commands, session entries, notifications, and network calls, and drives the
 * same event flow the real host uses for model and thinking changes.
 */
export class Harness {
  readonly agentDir: string;
  readonly cwd: string;
  readonly entries: Array<{ customType: string; data?: unknown }> = [];
  readonly notifications: Array<{ message: string; level: string }> = [];
  readonly statuses: Array<string | undefined> = [];
  readonly fetchCalls: FetchCall[] = [];
  readonly branch: Array<Record<string, unknown>> = [];

  model: FakeModel | undefined;
  thinking = "medium";

  private readonly handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  private readonly commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  private readonly models: FakeModel[];
  private readonly scoped: FakeModel[];
  private readonly projectTrusted: boolean;
  private readonly supportedThinking: string[] | undefined;
  private readonly thinkingDispatchDelayMs: number;
  private readonly providerApiKey: string | undefined;
  private readonly respond: (body: Record<string, unknown>, call: number) => unknown;
  private readonly originalFetch: typeof fetch;
  private readonly originalEnv: Record<string, string | undefined>;
  private readonly root: string;
  private disposed = false;

  constructor(options: HarnessOptions) {
    this.models = options.models;
    this.scoped = options.scopedModels ?? [];
    this.projectTrusted = options.projectTrusted ?? true;
    this.supportedThinking = options.supportedThinking;
    this.thinkingDispatchDelayMs = options.thinkingDispatchDelayMs ?? 0;
    this.providerApiKey = options.providerApiKey;
    this.respond = options.respond ?? (() => answers({}));
    this.originalFetch = globalThis.fetch;
    this.root = mkdtempSync(join(tmpdir(), "pi-router-test-"));
    this.agentDir = join(this.root, "agent");
    this.cwd = join(this.root, "project");
    mkdirSync(this.agentDir, { recursive: true });
    mkdirSync(join(this.cwd, ".pi"), { recursive: true });

    const envNames = ["PI_CODING_AGENT_DIR", "PI_ROUTER_MODE", "PI_ROUTER_OFF", "OPENROUTER_API_KEY"] as const;
    this.originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    delete process.env.PI_ROUTER_MODE;
    delete process.env.PI_ROUTER_OFF;
    if (options.envApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = options.envApiKey;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const headers = new Headers(init?.headers);
      this.fetchCalls.push({ url: String(url), body, authorization: headers.get("authorization") ?? undefined });
      const payload = this.respond(body, this.fetchCalls.length);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as Response;
    }) as typeof fetch;

    piRouter(this.api());
  }

  private context(): ExtensionContext {
    const harness = this;
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: this.cwd,
      get model() {
        return harness.model;
      },
      scopedModels: harness.scoped.map((model) => ({ model })),
      isProjectTrusted: () => harness.projectTrusted,
      modelRegistry: {
        find: (provider: string, id: string) => harness.models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => harness.models,
        getProviderAuth: async (provider: string) =>
          provider === "openrouter" && harness.providerApiKey ? { auth: { apiKey: harness.providerApiKey } } : undefined,
      },
      sessionManager: { getBranch: () => harness.branch },
      ui: {
        notify: (message: string, level = "info") => {
          harness.notifications.push({ message, level });
        },
        setStatus: (_id: string, value: string | undefined) => {
          harness.statuses.push(value);
        },
      },
    };
    return ctx as unknown as ExtensionContext;
  }

  private api(): Parameters<typeof piRouter>[0] {
    const harness = this;
    return {
      on: (type: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
        const list = harness.handlers.get(type) ?? [];
        list.push(handler as (event: unknown, ctx: ExtensionContext) => unknown);
        harness.handlers.set(type, list);
        return () => {};
      },
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
        harness.commands.set(name, options.handler);
      },
      appendEntry: (customType: string, data?: unknown) => {
        harness.entries.push({ customType, data });
        harness.branch.push({ type: "custom", customType, data });
      },
      setModel: async (model: FakeModel) => {
        const previous = harness.model;
        harness.model = { provider: model.provider, id: model.id };
        await harness.emit({ type: "model_select", model: harness.model, previousModel: previous, source: "set" });
        return true;
      },
      getThinkingLevel: () => harness.thinking,
      setThinkingLevel: (level: string) => harness.applyThinking(level, false),
    } as unknown as Parameters<typeof piRouter>[0];
  }

  private clampThinking(level: string): string {
    if (!this.supportedThinking) return level;
    const requested = THINKING_ORDER.indexOf(level);
    let best: string | undefined;
    for (const candidate of THINKING_ORDER) {
      if (this.supportedThinking.includes(candidate) && THINKING_ORDER.indexOf(candidate) <= requested) best = candidate;
    }
    return best ?? this.supportedThinking[0];
  }

  private applyThinking(level: string, immediate: boolean): void {
    const effective = this.clampThinking(level);
    if (effective === this.thinking) return;
    const previous = this.thinking;
    this.thinking = effective;
    const event = { type: "thinking_level_select", level: effective, previousLevel: previous };
    const invoke = () => {
      for (const handler of this.handlers.get("thinking_level_select") ?? []) {
        void handler(event, this.context());
      }
    };
    if (!immediate && this.thinkingDispatchDelayMs > 0) setTimeout(invoke, this.thinkingDispatchDelayMs);
    else invoke();
  }

  writeGlobalConfig(config: unknown): void {
    writeFileSync(join(this.agentDir, "pi-router.json"), JSON.stringify(config));
  }

  writeProjectConfig(config: unknown): void {
    writeFileSync(join(this.cwd, ".pi", "pi-router.json"), JSON.stringify(config));
  }

  async start(): Promise<void> {
    await this.emit({ type: "session_start" });
  }

  async emit(event: Record<string, unknown>): Promise<void> {
    for (const handler of this.handlers.get(String(event.type)) ?? []) {
      await handler(event, this.context());
    }
  }

  async turn(prompt: string): Promise<void> {
    await this.emit({ type: "before_agent_start", prompt });
  }

  async command(args: string): Promise<void> {
    const handler = this.commands.get("router");
    if (!handler) throw new Error("router command not registered");
    await handler(args, this.context());
  }

  /** Simulate the user selecting a model through Pi's own UI. */
  selectModel(model: FakeModel): void {
    const previous = this.model;
    this.model = { provider: model.provider, id: model.id };
    for (const handler of this.handlers.get("model_select") ?? []) {
      void handler({ type: "model_select", model: this.model, previousModel: previous, source: "set" }, this.context());
    }
  }

  selectThinking(level: string): void {
    this.applyThinking(level, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    globalThis.fetch = this.originalFetch;
    for (const [name, value] of Object.entries(this.originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}
