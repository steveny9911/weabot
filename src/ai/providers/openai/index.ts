/** The OpenAI provider: chat through the Responses API, and `\usage` from OpenAI billing. */
import { defineAiProvider } from "../module.ts";
import { createOpenAiProvider } from "./provider.ts";
import { createUsageService, formatUsageMessage, type UsageSettings } from "./usage.ts";

/** The `ai.openai` section of config.yaml. */
interface OpenAiFile {
  usage_project_id?: string;
}

export const openai = defineAiProvider<OpenAiFile, UsageSettings>({
  apiKeyEnv: "OPENAI_API_KEY",
  configKeys: ["usage_project_id"],
  parseConfig: (section, secret) => ({
    adminKey: secret("OPENAI_ADMIN_KEY"),
    projectId: section?.usage_project_id || undefined,
  }),
  create(settings, apiKey) {
    const usage = createUsageService(settings);
    return {
      ...createOpenAiProvider(apiKey),
      async usageReport() {
        return formatUsageMessage(await usage.getMonthToDate());
      },
    };
  },
});
