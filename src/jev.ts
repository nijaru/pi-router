import type { JevConfig, ProfileAssessment, RouteAnalysis } from "./types.ts";

export class JevError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

/** One capability profile as presented to Jev for a sufficiency judgment. */
export interface ProfileQuestion {
  id: string;
  description: string;
}

export interface ClassifyState {
  prompt: string;
  history?: string;
  project?: string;
  /** Available profiles in configured preference order. */
  profiles: ProfileQuestion[];
}

function clip(text: string | undefined, maxChars: number): string | undefined {
  if (!text || maxChars <= 0) return undefined;
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`;
}

function sufficiencyQuestion(description: string): Record<string, unknown> {
  return {
    type: "noul",
    instructions:
      "Decide whether this capability profile is sufficient to complete the request reliably and without material quality loss.\n\n" +
      `Profile scope: ${description}\n\n` +
      "Read recent_context when the request is a short follow-up. Answer true only when work at this scope should " +
      "produce a correct, high-quality result; answer false when the request needs more capability, sustained " +
      "reasoning, or judgment than the profile covers.",
    criteria: {
      true: "The profile scope covers the work needed for a reliable, high-quality result.",
      false: "The work exceeds the profile scope or needs more capability or reasoning than it provides.",
    },
  };
}

/**
 * Build a single OpenRouter Decisions request with one independent sufficiency
 * question per available profile.
 *
 * Questions are keyed by profile id and sorted by id so transport order does
 * not reveal the configured preference order. Neither profile order, pricing,
 * nor the currently selected model is disclosed.
 */
export function buildJevRequest(state: ClassifyState, config: JevConfig): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  const ordered = [...state.profiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const profile of ordered) {
    questions[profile.id] = sufficiencyQuestion(profile.description);
  }

  const body: Record<string, unknown> = {
    model: config.model,
    state: {
      request: clip(state.prompt, config.maxPromptChars),
      recent_context: clip(state.history, config.maxHistoryChars) ?? null,
      environment: {
        project: state.project ?? null,
      },
    },
    questions,
  };

  if (config.zeroDataRetention) {
    body.provider = { zdr: true, data_collection: "deny" };
  }
  return body;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A Jev `noul` answer is a probability and must stay within [0, 1]. */
function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function parseJevResponse(
  payload: unknown,
  profileIds: readonly string[],
  latencyMs: number,
): RouteAnalysis {
  if (typeof payload !== "object" || payload === null) throw new JevError("Jev returned a non-object response");
  const root = payload as Record<string, unknown>;
  if (typeof root.answers !== "object" || root.answers === null) throw new JevError("Jev response is missing answers");
  const answers = root.answers as Record<string, Record<string, unknown> | undefined>;

  const profiles: ProfileAssessment[] = profileIds.map((id) => {
    const value = probability(answers[id]?.noul);
    if (value === undefined) throw new JevError(`Jev response is missing a valid answer for profile "${id}"`);
    return { id, probability: value };
  });

  const usage = typeof root.usage === "object" && root.usage !== null ? (root.usage as Record<string, unknown>) : undefined;
  return {
    profiles,
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
  const profileIds = state.profiles.map((profile) => profile.id);
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
        return parseJevResponse(await response.json(), profileIds, Date.now() - started);
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
