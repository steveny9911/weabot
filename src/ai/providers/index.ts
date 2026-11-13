/**
 * The registry of AI providers selectable with ai.provider in config.yaml. This is the only list:
 * to add a provider, create its folder and register it here; to remove one, delete both.
 */
import type { AppConfig } from "../../config.ts";
import { gemini } from "./gemini/index.ts";
import { openai } from "./openai/index.ts";
import { openrouter } from "./openrouter/index.ts";
import type { AiProvider, AiProviderModule } from "./types.ts";

export const AI_PROVIDERS: Record<string, AiProviderModule> = { openai, gemini, openrouter };

/** The provider used when ai.provider is not set: the first one registered. */
export const DEFAULT_AI_PROVIDER = Object.keys(AI_PROVIDERS)[0] as string;

export function createAiProvider(
  config: AppConfig,
  providers: Record<string, AiProviderModule> = AI_PROVIDERS,
): AiProvider {
  const provider = providers[config.aiProvider];
  if (!provider) throw new Error(`FATAL: Unknown ai.provider: ${config.aiProvider}`);
  return provider.create(config);
}
