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
export function szExtractResponseText(data: Record<string, unknown>): string | null {
  const top_level_output_text = data.output_text;
  if (typeof top_level_output_text === "string" && top_level_output_text.trim().length > 0) {
    return top_level_output_text;
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
      const part_obj = part as Record<string, unknown>;

      // Common shape: { type: "output_text", text: "..." }
      if (typeof part_obj.text === "string" && part_obj.text.trim().length > 0) {
        chunks.push(part_obj.text);
        continue;
      }

      // Alternate shape: { type: "output_text", text: { value: "..." } }
      if (
        part_obj.text &&
        typeof part_obj.text === "object" &&
        typeof (part_obj.text as Record<string, unknown>).value === "string"
      ) {
        const value = (part_obj.text as Record<string, unknown>).value as string;
        if (value.trim().length > 0) chunks.push(value);
      }
    }
  }

  if (chunks.length === 0) return null;
  return chunks.join("\n").trim();
}

export function nReportedTokens(data: Record<string, unknown>): number {
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return 0;
  const total = (usage as Record<string, unknown>).total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0;
}
