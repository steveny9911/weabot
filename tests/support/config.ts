import type { AppConfig } from "../../src/config.ts";

/** A complete config for tests; pass only the settings a test depends on. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "test-channel",
    channelIds: ["test-channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    aiProvider: "openai",
    aiApiKey: "test-key",
    aiRateLimitPerUser: 5,
    aiDailyTokenBudget: 100_000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: ["test-channel"],
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
}
