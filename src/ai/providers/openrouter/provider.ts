/** OpenRouter Responses API through a preset, which holds Haru's persona, models and settings. */
import type { Fetcher } from "../../../types/fetch.ts";
import { createResponsesProvider, isObject } from "../responses.ts";
import type { AiProvider } from "../types.ts";

/** Output items a reply may hold. Anything else, such as a server tool, ran outside Haru's limits. */
const REPLY_ITEMS = ["message", "reasoning", "function_call"];

/** The checked `ai.openrouter` settings. */
export interface OpenRouterSettings {
  /** The slug of the preset that holds the persona, models and settings. */
  preset: string;
}

export function createOpenRouterProvider(
  settings: OpenRouterSettings,
  apiKey: string | undefined,
  deps: { fetch?: Fetcher } = {},
): AiProvider {
  const preset = `@preset/${settings.preset}`;
  return createResponsesProvider({
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/responses",
    apiKey,
    fetch: deps.fetch,
    // Persona, models and reasoning come from the preset, so the request sends none of them.
    body: ({ participation, pinned }) => ({
      model: pinned ? `${pinned}${preset}` : preset,
      // Only endpoints that honor the output format may answer a decision.
      ...(participation ? { provider: { require_parameters: true } } : {}),
    }),
    check: (output) =>
      output.some((item) => !isObject(item) || !REPLY_ITEMS.includes(String(item.type)))
        ? "OpenRouter response used a server tool: turn them off in the preset"
        : undefined,
  });
}
