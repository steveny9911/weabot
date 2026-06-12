import { assertEquals } from "@std/assert";
import { handleMessage } from "./bot_actions.ts";
import type { BotDependencies } from "./bot_actions.ts";
import type { AppConfig } from "./src/config.ts";
import type { BudgetResult, RateLimitResult, UsageStats } from "./src/services/rate_limit.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "",
    channelId: "chan-1",
    channelIds: ["chan-1"],
    timeZone: "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 30,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
}

Deno.test("handleMessage exits when bot id cannot be fetched", async () => {
  let ai_calls = 0;
  const config = createMockConfig({ discordToken: "" });
  const deps: BotDependencies = {
    config,
    aiService: {
      generateReply(_messages: Array<Record<string, unknown>>) {
        ai_calls++;
        return Promise.resolve({ ok: true, text: "ok", tokensUsed: 1 });
      },
    },
    rateLimitService: {
      checkUserRateLimit(_userId: string): Promise<RateLimitResult> {
        return Promise.resolve({ allowed: true, remaining: 1, resetInMs: 1000 });
      },
      recordUserRequest(_userId: string): Promise<void> {
        return Promise.resolve();
      },
      checkDailyBudget(): Promise<BudgetResult> {
        return Promise.resolve({ allowed: true, tokensRemaining: 999 });
      },
      recordTokenUsage(_tokens: number): Promise<void> {
        return Promise.resolve();
      },
      getUsageStats(): Promise<UsageStats> {
        return Promise.resolve({
          dailyTokensUsed: 0,
          dailyTokenBudget: config.aiDailyTokenBudget,
          requestsToday: 0,
        });
      },
    },
    linkOpenService: {
      open(_url: string) {
        return Promise.resolve({
          ok: false as const,
          error: "fetch_failed" as const,
        });
      },
    },
    webSearchService: {
      search(_query: string) {
        return Promise.resolve({ ok: true as const, results: [] });
      },
    },
  };

  await handleMessage(
    {
      id: "msg-1",
      channel_id: "chan-1",
      content: "<@12345> hi",
      author: { id: "u1", username: "alice", bot: false },
      mentions: [{ id: "12345" }],
    },
    deps,
  );

  assertEquals(ai_calls, 0);
});
