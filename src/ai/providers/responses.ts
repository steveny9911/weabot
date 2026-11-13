/** Reading and writing the OpenAI Responses API shapes, shared by the providers that speak it. */
import type { ProviderRequest, ToolCall } from "./types.ts";

/** The Responses API input: instructions as a developer item, then the user turn. */
export function buildInput(request: ProviderRequest): unknown[] {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: request.userText }];
  for (const imageUrl of request.imageUrls) {
    content.push({ type: "input_image", image_url: imageUrl });
  }
  return [
    ...(request.instructions !== undefined
      ? [{ role: "developer", content: request.instructions }]
      : []),
    { role: "user", content },
    ...(request.currentUserMessage ? [{ role: "user", content: request.currentUserMessage }] : []),
  ];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorTokenUsage(body: string): number {
  try {
    const data: unknown = JSON.parse(body);
    return isObject(data) ? readTokenUsage(data) : 0;
  } catch {
    // Non-JSON provider errors have no reported usage to record.
    return 0;
  }
}

export function readTokenUsage(data: Record<string, unknown>): number {
  const usage = data.usage;
  if (!isObject(usage)) return 0;
  const total = usage.total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0;
}

/** Autonomous output must be one completed assistant message of plain output text. */
export function participationText(data: Record<string, unknown>): string | null {
  if (data.status !== undefined && data.status !== "completed") return null;
  if (data.output !== undefined) {
    if (!Array.isArray(data.output)) return null;
    for (const item of data.output) {
      if (!isObject(item)) return null;
      if (item.type === "reasoning") continue;
      if (
        item.type !== "message" ||
        item.role !== "assistant" ||
        (item.status !== undefined && item.status !== "completed") ||
        !Array.isArray(item.content) ||
        item.content.some((part: unknown) => !isObject(part) || part.type !== "output_text")
      )
        return null;
    }
  }
  return extractResponseText(data);
}

/** Reply text from either `output_text` or the structured `output[].content[]` shape. */
export function extractResponseText(data: Record<string, unknown>): string | null {
  const topLevelOutputText = data.output_text;
  if (typeof topLevelOutputText === "string" && topLevelOutputText.trim().length > 0) {
    return topLevelOutputText;
  }

  const output = data.output;
  if (!Array.isArray(output)) return null;

  const chunks: string[] = [];
  for (const item of output) {
    // A reasoning item may carry its text in `content`; it is never part of the reply.
    if (!isObject(item) || item.type === "reasoning" || !Array.isArray(item.content)) continue;

    for (const part of item.content) {
      if (!isObject(part)) continue;

      // Common shape: { type: "output_text", text: "..." }
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        chunks.push(part.text);
        continue;
      }

      // Alternate shape: { type: "output_text", text: { value: "..." } }
      if (isObject(part.text) && typeof part.text.value === "string") {
        if (part.text.value.trim().length > 0) chunks.push(part.text.value);
      }
    }
  }

  if (chunks.length === 0) return null;
  return chunks.join("\n").trim();
}

/** The function calls in a response's output items, in order. */
export function toolCallsFrom(output: unknown[]): ToolCall[] {
  return output.filter(isObject).flatMap((item) =>
    item.type === "function_call"
      ? [
          {
            id: typeof item.call_id === "string" ? item.call_id : "",
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : undefined,
          },
        ]
      : [],
  );
}
