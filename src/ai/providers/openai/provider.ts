/** OpenAI Responses API with the saved dashboard prompt, which holds Haru's persona and model. */
import type { AppConfig } from "../../../config.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../../participation.ts";
import {
  buildInput,
  errorTokenUsage,
  extractResponseText,
  isObject,
  participationText,
  readTokenUsage,
} from "../responses.ts";
import type { AiProvider, ProviderStep, ToolCall } from "../types.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_BUILDER_PROMPT = {
  id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
} as const;

export function createOpenAiProvider(config: AppConfig): AiProvider {
  return {
    label: "OpenAI",
    missingKeyError: "OPENAI_API_KEY not set",
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
