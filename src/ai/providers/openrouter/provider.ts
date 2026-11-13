/** OpenRouter Responses API through a preset, which holds Haru's persona, models and settings. */
import type { AppConfig } from "../../../config.ts";
import type { Fetcher } from "../../../types/fetch.ts";
import {
  buildInput,
  errorTokenUsage,
  extractResponseText,
  isObject,
  readTokenUsage,
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
      let calls = 0;
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          if (request.tools || request.format === "participation") {
            return { ok: false, error: "OpenRouter supports text replies only so far", tokens: 0 };
          }
          calls++;
          // Persona, models and reasoning come from the preset, so the request sends none of them.
          const res = await fetchImpl(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.aiApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              input,
              text: { format: { type: "text" } },
              tool_choice: "none",
            }),
            signal,
          });
          if (!res.ok) {
            const body = await res.text();
            return {
              ok: false,
              error: `OpenRouter error ${res.status}: ${body}`,
              tokens: errorTokenUsage(body),
            };
          }

          const json: unknown = await res.json();
          const data = isObject(json) ? json : {};
          console.log("[AI] model:", data.model);
          return {
            ok: true,
            text: extractResponseText(data),
            toolCalls: [],
            tokens: readTokenUsage(data),
          };
        },

        addToolResults() {
          throw new Error("OpenRouter does not run tools yet");
        },
      };
    },
  };
}
