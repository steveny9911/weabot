/**
 * The registry of AI providers selectable with ai.provider in config.yaml. This is the only list:
 * to add a provider, create its folder and register it here; to remove one, delete both.
 */
import { gemini } from "./gemini/index.ts";
import type { AiProviderModule } from "./module.ts";
import { openai } from "./openai/index.ts";
import { openrouter } from "./openrouter/index.ts";

export const AI_PROVIDERS: Record<string, AiProviderModule> = { openai, gemini, openrouter };
