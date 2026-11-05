/** OpenAI Responses API helpers: request deadlines, reply text and reported token usage. */

/** Bound both receiving headers and consuming the response body. */
export async function withResponseDeadline<T>(
  timeoutMs: number,
  timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts assistant text from OpenAI Responses API payloads.
 * Handles both `output_text` and structured `output[].content[]` shapes.
 */
export function extractResponseText(data: Record<string, unknown>): string | null {
  const topLevelOutputText = data.output_text;
  if (typeof topLevelOutputText === "string" && topLevelOutputText.trim().length > 0) {
    return topLevelOutputText;
  }

  const output = data.output;
  if (!Array.isArray(output)) return null;

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partObj = part as Record<string, unknown>;

      // Common shape: { type: "output_text", text: "..." }
      if (typeof partObj.text === "string" && partObj.text.trim().length > 0) {
        chunks.push(partObj.text);
        continue;
      }

      // Alternate shape: { type: "output_text", text: { value: "..." } }
      if (
        partObj.text &&
        typeof partObj.text === "object" &&
        typeof (partObj.text as Record<string, unknown>).value === "string"
      ) {
        const value = (partObj.text as Record<string, unknown>).value as string;
        if (value.trim().length > 0) chunks.push(value);
      }
    }
  }

  if (chunks.length === 0) return null;
  return chunks.join("\n").trim();
}

export function readTokenUsage(data: Record<string, unknown>): number {
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return 0;
  const total = (usage as Record<string, unknown>).total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0;
}
