/** OpenRouter Responses API through a preset, which holds Haru's persona, models and settings. */
import type { AppConfig } from "../../../config.ts";
import type { Fetcher } from "../../../types/fetch.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../../participation.ts";
import {
  buildInput,
  errorTokenUsage,
  extractResponseText,
  isObject,
  participationText,
  readTokenUsage,
  toolCallsFrom,
} from "../responses.ts";
import type { AiProvider, ProviderStep } from "../types.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/responses";
const PRESET_PREFIX = "@preset/";

/** `haru` and `@preset/haru` both name the preset; requests use the `@preset/` form. */
export function presetModel(preset: string): string {
  const slug = preset.trim().replace(/^@preset\//, "");
  return `${PRESET_PREFIX}${slug}`;
}

export function createOpenRouterProvider(
  config: AppConfig,
  deps: { fetch?: Fetcher } = {},
): AiProvider {
  if (!config.aiPreset?.trim()) {
    throw new Error("FATAL: ai.preset is required for the openrouter provider");
  }
  const model = presetModel(config.aiPreset);
  const fetchImpl: Fetcher = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    label: "OpenRouter",
    missingKeyError: "AI_API_KEY not set",
    start(request) {
      const input = buildInput(request);
      let lastOutput: unknown[] = [];
      let calls = 0;
      // The preset may rotate between models, but tool results only make sense to the model that
      // asked for them, so later steps are pinned to the one that answered first.
      let pinned: string | undefined;
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          const participation = request.format === "participation";
          calls++;
          // Persona, models and reasoning come from the preset, so the request sends none of them.
          const res = await fetchImpl(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.aiApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: pinned ? `${pinned}@${model.slice(1)}` : model,
              input,
              text: { format: participation ? AUTONOMOUS_PARTICIPATION_FORMAT : { type: "text" } },
              // Only endpoints that honor the output format may answer a decision.
              ...(participation ? { provider: { require_parameters: true } } : {}),
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
              error: `OpenRouter error ${res.status}: ${body}`,
              tokens: participation ? errorTokenUsage(body) : 0,
            };
          }

          const json: unknown = await res.json();
          const data = isObject(json) ? json : {};
          console.log("[AI] model:", data.model);
          const tokens = readTokenUsage(data);
          if (request.tools && (data.status === "incomplete" || data.status === "failed")) {
            return { ok: false, error: `OpenRouter response ${data.status}`, tokens };
          }

          lastOutput = Array.isArray(data.output) ? data.output : [];
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
