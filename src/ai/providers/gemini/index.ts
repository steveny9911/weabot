/** The Gemini provider: chat through @google/genai. It has no billing report. */
import type { AiProviderModule } from "../types.ts";
import { createGeminiProvider } from "./provider.ts";

export const gemini: AiProviderModule = {
  create: (config) => createGeminiProvider(config),
};
