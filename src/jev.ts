import type { JevConfig, RouteAnalysis } from "./types.ts";

export class JevError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

export interface ClassifyState {
  prompt: string;
  history?: string;
  project?: string;
  currentModel?: string;
  currentThinking?: string;
}

function clip(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`;
}

export function buildJevRequest(state: ClassifyState, config: JevConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    state: {
      request: clip(state.prompt, config.maxPromptChars),
      recent_context: clip(state.history, config.maxHistoryChars) ?? null,
      environment: {
        project: state.project ?? null,
        current_model: state.currentModel ?? null,
        current_thinking: state.currentThinking ?? null,
      },
    },
    questions: {
      low_effort_sufficient: {
        type: "noul",
        instructions:
          "Can a strong, efficient coding/reasoning model at LOW reasoning effort handle this request without material quality loss? Read recent_context for short follow-ups. Answer true for direct edits, routine commands, simple explanations, or obvious continuation work. Answer false when sustained reasoning is needed even if an efficient model could still do the job at higher effort.",
        criteria: {
          true: "Low-effort inference is enough to complete the work reliably.",
          false: "The request needs sustained reasoning or careful tradeoff analysis.",
        },
      },
      expert_materially_better: {
        type: "noul",
        instructions:
          "Would a top-tier frontier model be materially more likely than a strong efficient model to produce a correct, high-quality outcome for this request? Read recent_context for follow-ups. Answer true for architectural or system-level design, subtle cross-cutting debugging, novel/ambiguous high-stakes decisions, or work where missing a hidden constraint is costly. Answer false for bounded implementation, routine debugging, lookup, editing, or familiar patterns.",
        criteria: {
          true: "Frontier capability is likely to materially improve correctness or judgment.",
          false: "A strong efficient model should be sufficient without meaningful quality loss.",
        },
      },
      reasoning_depth: {
        type: "score",
        instructions:
          "How much reasoning depth does this request require to do well? Judge the requested work, not the sophistication of the topic name. Use recent_context when the request is a continuation.",
        criteria: [
          "Direct/local: mechanical or one obvious step; little or no inference needed",
          "Bounded: several dependent steps using familiar patterns; modest debugging or reasoning",
          "Complex: interacting constraints, multiple files/subsystems, non-obvious debugging or tradeoffs",
          "Architectural: cross-cutting design, novel reasoning, consequential ambiguity, or long-horizon system decisions",
        ],
      },
    },
  };

  if (config.zeroDataRetention) {
    body.provider = { zdr: true, data_collection: "deny" };
  }
  return body;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJevResponse(payload: unknown, latencyMs: number): RouteAnalysis {
  if (typeof payload !== "object" || payload === null) throw new JevError("Jev returned a non-object response");
  const root = payload as Record<string, unknown>;
  if (typeof root.answers !== "object" || root.answers === null) throw new JevError("Jev response is missing answers");
  const answers = root.answers as Record<string, Record<string, unknown>>;

  const low = finite(answers.low_effort_sufficient?.noul);
  const expert = finite(answers.expert_materially_better?.noul);
  const depth = finite(answers.reasoning_depth?.score);
  if (low === undefined || expert === undefined || depth === undefined) {
    throw new JevError("Jev response is missing required decision values");
  }

  const usage = typeof root.usage === "object" && root.usage !== null ? (root.usage as Record<string, unknown>) : undefined;
  return {
    lowEffortSufficient: low,
    expertMateriallyBetter: expert,
    reasoningDepth: depth,
    latencyMs,
    model: typeof root.model === "string" ? root.model : undefined,
    usage: usage
      ? {
          inputTokens: finite(usage.input_tokens),
          cost: finite(usage.cost),
        }
      : undefined,
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export async function classifyWithJev(
  state: ClassifyState,
  config: JevConfig,
  apiKey: string,
  externalSignal?: AbortSignal,
): Promise<RouteAnalysis> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  const body = buildJevRequest(state, config);
  const started = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new JevError(`OpenRouter Decisions ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`, response.status);
        if (response.status !== 429 && response.status !== 529) throw error;
        lastError = error;
      } else {
        return parseJevResponse(await response.json(), Date.now() - started);
      }
    } catch (error) {
      if (signal.aborted) throw new JevError("Jev request timed out or was aborted");
      lastError = error;
      if (error instanceof JevError && error.status !== 429 && error.status !== 529) throw error;
    }
    if (attempt === 0) await sleep(200, signal);
  }
  throw lastError instanceof Error ? lastError : new JevError("Jev request failed");
}
