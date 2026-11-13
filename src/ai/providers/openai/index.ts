/** The OpenAI provider: chat through the Responses API, and `\usage` from OpenAI billing. */
import type { AiProviderModule } from "../types.ts";
import { createOpenAiProvider } from "./provider.ts";
import { createUsageService, formatUsageMessage } from "./usage.ts";

export const openai: AiProviderModule = {
  apiKeyEnv: "OPENAI_API_KEY",
  create(config) {
    const usage = createUsageService(config);
    return {
      ...createOpenAiProvider(config),
      async usageReport() {
        return formatUsageMessage(await usage.getMonthToDate());
      },
    };
  },
};
