/** The Gemini provider: chat through @google/genai. It has no billing report. */
import { defineAiProvider } from "../module.ts";
import { createGeminiProvider, type GeminiSettings } from "./provider.ts";

/** The `ai.gemini` section of config.yaml. */
interface GeminiFile {
  models?: string[];
  system_prompt_file?: string;
  thinking?: boolean;
}

export const gemini = defineAiProvider<GeminiFile, GeminiSettings>({
  apiKeyEnv: "GEMINI_API_KEY",
  configKeys: { models: true, system_prompt_file: true, thinking: true },
  parseConfig(section) {
    const models = [...new Set(section?.models ?? [])];
    if (models.length === 0) throw new Error("FATAL: ai.gemini.models is required in config.yaml");
    if (!section?.system_prompt_file) {
      throw new Error("FATAL: ai.gemini.system_prompt_file is required in config.yaml");
    }
    return {
      models,
      systemPromptFile: section.system_prompt_file,
      thinking: section.thinking ?? false,
    };
  },
  create: createGeminiProvider,
});
