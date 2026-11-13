/** The OpenRouter provider: chat through the Responses API with a preset. */
import { defineAiProvider } from "../module.ts";
import { createOpenRouterProvider, type OpenRouterSettings } from "./provider.ts";

/** The `ai.openrouter` section of config.yaml. */
interface OpenRouterFile {
  preset?: string;
}

export const openrouter = defineAiProvider<OpenRouterFile, OpenRouterSettings>({
  apiKeyEnv: "OPENROUTER_API_KEY",
  configKeys: { preset: true },
  parseConfig(section) {
    const preset = section?.preset?.trim();
    if (!preset) throw new Error("FATAL: ai.openrouter.preset is required in config.yaml");
    return { preset };
  },
  create: createOpenRouterProvider,
});
