/** The registry of AI providers selectable with AI_PROVIDER. */
import type { AppConfig } from "../../config.ts";
import { createOpenAiProvider } from "./openai.ts";
import type { AiProvider } from "./types.ts";

export const AI_PROVIDERS = {
  openai: createOpenAiProvider,
} satisfies Record<string, (config: AppConfig) => AiProvider>;

export type AiProviderName = keyof typeof AI_PROVIDERS;

export function isAiProviderName(name: string): name is AiProviderName {
  return Object.hasOwn(AI_PROVIDERS, name);
}

export function createAiProvider(config: AppConfig): AiProvider {
  return AI_PROVIDERS[config.aiProvider ?? "openai"](config);
}
