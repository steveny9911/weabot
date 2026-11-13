/** The OpenRouter provider: chat through the Responses API with a preset. */
import type { AiProviderModule } from "../types.ts";
import { createOpenRouterProvider } from "./provider.ts";

export const openrouter: AiProviderModule = {
  apiKeyEnv: "OPENROUTER_API_KEY",
  create: (config) => createOpenRouterProvider(config),
};
