import type { AppConfig } from "../../src/config.ts";

/** `T` with every setting optional, however deep, so a test names only what it depends on. */
export type ConfigOverrides<T = AppConfig> = {
  [K in keyof T]?: unknown extends T[K]
    ? T[K]
    : T[K] extends string | number | boolean | unknown[]
      ? T[K]
      : ConfigOverrides<T[K]>;
};

const isSection = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sections merge setting by setting; anything else, including an explicit undefined, replaces. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isSection(base) || !isSection(patch)) return patch;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) merged[key] = merge(base[key], value);
  return merged;
}

/** Built fresh for each call, so a test that changes its config cannot affect another. */
function defaults(): AppConfig {
  const feature = () => ({ enabled: true, channelIds: "all" as const });
  const channels = () => ["test-channel"];
  return {
    discordToken: "test-token",
    channelIds: channels(),
    databasePath: ":memory:",
    httpPort: 8000,
    timeZone: "UTC",
    aiEnabled: true,
    aiChat: feature(),
    aiProvider: "openai",
    aiApiKeyEnv: "OPENAI_API_KEY",
    aiProviderSettings: {},
    aiApiKey: "test-key",
    aiRateLimitPerUser: 5,
    aiDailyTokenBudget: 100_000,
    aiDailyRequestPercent: 90,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearch: { enabled: false, channelIds: "all", apiKey: undefined, maxResults: 3 },
    linkOpen: feature(),
    tweetRead: feature(),
    discordActions: { enabled: false, channelIds: "all", guildIds: [] },
    moodPoll: { enabled: true, channelIds: channels() },
    wellness: { enabled: true, channelIds: channels(), glueAlertThreshold: 7 },
    weeklyStats: { enabled: true, channelIds: channels() },
    autonomousChat: {
      enabled: false,
      channelIds: channels(),
      minHumanMessages: 4,
      activityWindowMinutes: 20,
      cooldownMinutes: 1,
      replyChance: 0.35,
      maxContextMessages: 40,
      requestPercent: 30,
    },
    landmine: {
      enabled: false,
      channelIds: channels(),
      chance: 0.1,
      stepPenalty: { enabled: true, timeoutSeconds: 60 },
      gifs: [],
    },
  };
}

/** A complete config for tests. Each override is merged in turn, so pass only what a test needs. */
export function testConfig(...overrides: ConfigOverrides[]): AppConfig {
  return overrides.reduce<AppConfig>(
    (config, patch) => merge(config, patch) as AppConfig,
    defaults(),
  );
}
