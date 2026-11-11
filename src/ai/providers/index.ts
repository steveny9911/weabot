/** The registry of AI providers selectable with ai.provider in config.yaml. */
import type { AppConfig } from "../../config.ts";
import type { AiProviderName } from "../../config.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAiProvider } from "./openai.ts";
import type { AiProvider } from "./types.ts";

export const AI_PROVIDERS = {
  openai: createOpenAiProvider,
  gemini: createGeminiProvider,
} satisfies Record<AiProviderName, (config: AppConfig) => AiProvider>;

export function createAiProvider(config: AppConfig): AiProvider {
  return AI_PROVIDERS[config.aiProvider](config);
}

/** Turns off the features the selected provider cannot do. */
export function withProviderLimits(config: AppConfig): AppConfig {
  const { tools, autonomous } = createAiProvider(config).capabilities;
  return {
    ...config,
    discordActions: { ...config.discordActions, enabled: config.discordActions.enabled && tools },
    autonomousChat: {
      ...config.autonomousChat,
      enabled: config.autonomousChat.enabled && autonomous,
    },
  };
}
