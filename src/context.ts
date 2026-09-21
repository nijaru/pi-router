function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export interface BranchEntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Build a compact excerpt of the most recent user/assistant messages.
 *
 * Pi emits `before_agent_start` before the current user message is persisted,
 * so the branch never contains the prompt being classified and no
 * deduplication against it is needed.
 */
export function recentConversationContext(branch: readonly BranchEntryLike[], maxChars: number): string | undefined {
  if (maxChars <= 0) return undefined;

  const messages: string[] = [];
  for (let i = branch.length - 1; i >= 0 && messages.length < 4; i -= 1) {
    const entry = branch[i];
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(entry.message.content).trim();
    if (!text) continue;
    messages.push(`${role}: ${text}`);
  }

  if (messages.length === 0) return undefined;
  const joined = messages.reverse().join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}
