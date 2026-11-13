/** OpenAI Responses API with the saved dashboard prompt, which holds Haru's persona and model. */
import { createResponsesProvider } from "../responses.ts";
import type { AiProvider } from "../types.ts";

const OPENAI_CHAT_BUILDER_PROMPT = {
  id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
} as const;

export function createOpenAiProvider(apiKey: string | undefined): AiProvider {
  return createResponsesProvider({
    label: "OpenAI",
    url: "https://api.openai.com/v1/responses",
    apiKey,
    body: () => ({ prompt: OPENAI_CHAT_BUILDER_PROMPT, store: true }),
  });
}
