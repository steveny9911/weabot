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
  configKeys: ["models", "system_prompt_file", "thinking"],
  parseConfig(section) {
    const { models: list, thinking } = section ?? {};
    if (!Array.isArray(list) || list.length === 0 || list.some((m) => typeof m !== "string")) {
      throw new Error("FATAL: ai.gemini.models must be a list of model names in config.yaml");
    }
    if (thinking !== undefined && typeof thinking !== "boolean") {
      throw new Error("FATAL: ai.gemini.thinking must be true or false in config.yaml");
    }
    const models = [...new Set(list)];
    if (!section?.system_prompt_file) {
      throw new Error("FATAL: ai.gemini.system_prompt_file is required in config.yaml");
    }
    return {
      models,
      systemPromptFile: section.system_prompt_file,
      thinking: thinking ?? false,
    };
  },
  create: createGeminiProvider,
});
