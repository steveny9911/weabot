/** OpenAI Responses API with the saved dashboard prompt, which holds Haru's persona and model. */
import type { AppConfig } from "../../config.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../participation.ts";
import type { AiProvider, ProviderRequest, ProviderStep, ToolCall } from "./types.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_BUILDER_PROMPT = {
  id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
} as const;

export function createOpenAiProvider(config: AppConfig): AiProvider {
  return {
    label: "OpenAI",
    missingKeyError: "OPENAI_API_KEY not set",
    capabilities: { tools: true, autonomous: true },
    start(request) {
      const input = buildInput(request);
      let lastOutput: unknown[] = [];
      let calls = 0;
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          const participation = request.format === "participation";
          calls++;
          const res = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.aiApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              prompt: OPENAI_CHAT_BUILDER_PROMPT,
              text: { format: participation ? AUTONOMOUS_PARTICIPATION_FORMAT : { type: "text" } },
              store: true,
              input,
              ...(request.tools
                ? { tools: request.tools, parallel_tool_calls: false }
                : { tool_choice: "none" }),
            }),
            signal,
          });
          if (!res.ok) {
            const body = await res.text();
            return {
              ok: false,
              error: `OpenAI error ${res.status}: ${body}`,
              tokens: participation ? errorTokenUsage(body) : 0,
            };
          }

          const json: unknown = await res.json();
          const data = isObject(json) ? json : {};
          if (participation && !isObject(json)) {
            return { ok: true, text: null, toolCalls: [], tokens: 0 };
          }
          const tokens = readTokenUsage(data);
          if (request.tools && (data.status === "incomplete" || data.status === "failed")) {
            return { ok: false, error: `OpenAI response ${data.status}`, tokens };
          }

          lastOutput = Array.isArray(data.output) ? data.output : [];
          const toolCalls: ToolCall[] = lastOutput.filter(isObject).flatMap((item) =>
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
          const text = participation ? participationText(data) : extractResponseText(data);
          return { ok: true, text, toolCalls, tokens };
        },

        addToolResults(calls, results) {
          // Reasoning and every other output item must survive manual continuation.
          input.push(...lastOutput);
          calls.forEach((call, index) =>
            input.push({ type: "function_call_output", call_id: call.id, output: results[index] }),
          );
        },
      };
    },
  };
}

function buildInput(request: ProviderRequest): unknown[] {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorTokenUsage(body: string): number {
  try {
    const data: unknown = JSON.parse(body);
    return isObject(data) ? readTokenUsage(data) : 0;
  } catch {
    // Non-JSON provider errors have no reported usage to record.
    return 0;
  }
}

function readTokenUsage(data: Record<string, unknown>): number {
  const usage = data.usage;
  if (!isObject(usage)) return 0;
  const total = usage.total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0;
}

/** Autonomous output must be one completed assistant message of plain output text. */
function participationText(data: Record<string, unknown>): string | null {
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
function extractResponseText(data: Record<string, unknown>): string | null {
  const topLevelOutputText = data.output_text;
  if (typeof topLevelOutputText === "string" && topLevelOutputText.trim().length > 0) {
    return topLevelOutputText;
  }

  const output = data.output;
  if (!Array.isArray(output)) return null;

  const chunks: string[] = [];
  for (const item of output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;

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
