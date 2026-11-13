/**
 * The registry of AI providers selectable with ai.provider in config.yaml. This is the only list:
 * to add a provider, create its folder and register it here; to remove one, delete both.
 */
import { gemini } from "./gemini/index.ts";
import type { AiProviderModule } from "./module.ts";
import { openai } from "./openai/index.ts";
import { openrouter } from "./openrouter/index.ts";
import type { AiProvider } from "./types.ts";

export const AI_PROVIDERS: Record<string, AiProviderModule> = { openai, gemini, openrouter };

/** Builds the provider named by ai.provider from the settings config.ts already checked. */
export function createAiProvider(
  config: { aiProvider?: string; aiProviderSettings?: unknown; aiApiKey?: string },
  providers: Record<string, AiProviderModule> = AI_PROVIDERS,
): AiProvider {
  const { aiProvider } = config;
  const provider =
    aiProvider && Object.hasOwn(providers, aiProvider) ? providers[aiProvider] : undefined;
  if (!provider) throw new Error(`FATAL: Unknown ai.provider: ${config.aiProvider}`);
  return provider.create(config.aiProviderSettings, config.aiApiKey);
}
