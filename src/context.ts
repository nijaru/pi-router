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

export function recentConversationContext(
  branch: readonly BranchEntryLike[],
  currentPrompt: string,
  maxChars: number,
): string | undefined {
  const messages: string[] = [];
  let skippedCurrent = false;

  for (let i = branch.length - 1; i >= 0 && messages.length < 4; i -= 1) {
    const entry = branch[i];
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(entry.message.content).trim();
    if (!text) continue;

    if (!skippedCurrent && role === "user" && normalize(text) === normalize(currentPrompt)) {
      skippedCurrent = true;
      continue;
    }
    messages.push(`${role}: ${text}`);
  }

  if (messages.length === 0) return undefined;
  const joined = messages.reverse().join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
