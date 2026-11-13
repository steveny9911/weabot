/** The OpenAI Responses API, shared by the providers that speak it. */
import type { Fetcher } from "../../types/fetch.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../participation.ts";
import type { AiProvider, ProviderRequest, ProviderStep, ToolCall } from "./types.ts";

/** What a provider adds to the shared Responses client. */
interface ResponsesOptions {
  label: string;
  url: string;
  apiKey: string | undefined;
  fetch?: Fetcher;
  /** The request fields only this provider sends. `pinned` is the model that asked for tools. */
  body(ctx: { participation: boolean; pinned?: string }): Record<string, unknown>;
  /** Returns an error for output the provider must refuse. */
  check?(output: unknown[]): string | undefined;
}

export function createResponsesProvider(options: ResponsesOptions): AiProvider {
  const { label, url, apiKey, body, check } = options;
  const fetchImpl: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    label,
    start(request) {
      const input = buildInput(request);
      let lastOutput: unknown[] = [];
      let calls = 0;
      // Tool results only make sense to the model that asked for them, so a provider that rotates
      // models pins the later steps to the one that answered first.
      let pinned: string | undefined;
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          const participation = request.format === "participation";
          calls++;
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body({ participation, pinned }),
              input,
              text: { format: participation ? AUTONOMOUS_PARTICIPATION_FORMAT : { type: "text" } },
              ...(request.tools
                ? { tools: request.tools, parallel_tool_calls: false }
                : { tool_choice: "none" }),
            }),
            signal,
          });
          if (!res.ok) {
            const text = await res.text();
            return {
              ok: false,
              error: `${label} error ${res.status}: ${text}`,
              tokens: participation ? errorTokenUsage(text) : 0,
            };
          }

          const json: unknown = await res.json();
          const data = isObject(json) ? json : {};
          console.log("[AI] model:", data.model);
          const tokens = readTokenUsage(data);
          if (request.tools && (data.status === "incomplete" || data.status === "failed")) {
            const why = isObject(data.incomplete_details)
              ? data.incomplete_details.reason
              : undefined;
            const detail = why ?? (isObject(data.error) ? data.error.message : undefined);
            return {
              ok: false,
              error: `${label} response ${data.status}${detail ? `: ${detail}` : ""}`,
              tokens,
            };
          }

          lastOutput = Array.isArray(data.output) ? data.output : [];
          const error = check?.(lastOutput);
          if (error) return { ok: false, error, tokens };
          const toolCalls = toolCallsFrom(lastOutput);
          if (toolCalls.length > 0 && typeof data.model === "string") pinned = data.model;
          const text = participation ? participationText(data) : extractResponseText(data);
          return { ok: true, text, toolCalls, tokens };
        },

        addToolResults(toolCalls, results) {
          // Reasoning and every other output item must survive manual continuation.
          input.push(...lastOutput);
          toolCalls.forEach((call, index) =>
            input.push({ type: "function_call_output", call_id: call.id, output: results[index] }),
          );
        },
      };
    },
  };
}

/** The Responses API input: instructions as a developer item, then the user turn. */
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

export function isObject(value: unknown): value is Record<string, unknown> {
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
function toolCallsFrom(output: unknown[]): ToolCall[] {
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
