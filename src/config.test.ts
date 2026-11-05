/**
 * Tests for Configuration Module
 */

import { expect, test } from "bun:test";
import { throws } from "../test_support/assert.ts";
import { loadConfig } from "./config.ts";

// Helper to run tests with specific env vars
function withEnv(envVars: Record<string, string>, fn: () => void) {
  // Save original values
  const originalValues: Record<string, string | undefined> = {};
  const allKeys = new Set([
    ...Object.keys(envVars),
    "DISCORD_TOKEN",
    "ADMIN_HTTP_TOKEN",
    "CHANNEL_ID",
    "CHANNEL_IDS",
    "TIME_ZONE",
    "GLUE_ALERT_THRESHOLD",
    "AI_ENABLED",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "USAGE_OPENAI_PROJECT_ID",
    "AI_RATE_LIMIT_PER_USER",
    "AI_DAILY_TOKEN_BUDGET",
    "AI_MAX_INPUT_CHARS",
    "ENABLE_UWU",
    "AI_CONTEXT_MAX_MESSAGES",
    "AI_CONTEXT_INACTIVITY_MINUTES",
    "WEB_SEARCH_ENABLED",
    "BRAVE_SEARCH_API_KEY",
    "WEB_SEARCH_MAX_RESULTS",
    "LINK_OPEN_ENABLED",
    "DISCORD_ACTIONS_ENABLED",
    "DISCORD_ACTIONS_GUILD_IDS",
    "AUTONOMOUS_CHAT_ENABLED",
    "AUTONOMOUS_CHAT_CHANNEL_IDS",
    "AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES",
    "AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES",
    "AUTONOMOUS_CHAT_COOLDOWN_MINUTES",
    "AUTONOMOUS_CHAT_REPLY_CHANCE",
    "AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES",
  ]);

  for (const key of allKeys) {
    originalValues[key] = process.env[key];
    delete process.env[key];
  }

  // Set test values
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    // Restore original values
    for (const key of allKeys) {
      const original = originalValues[key];
      if (original !== undefined) {
        process.env[key] = original;
      } else {
        delete process.env[key];
      }
    }
  }
}

// =============================================================================
// loadConfig - Required Variables
// =============================================================================

test("loadConfig throws when DISCORD_TOKEN is missing", () => {
  withEnv({ CHANNEL_ID: "123" }, () => {
    throws(() => loadConfig(), Error, "Missing required environment variable: DISCORD_TOKEN");
  });
});

test("loadConfig throws when CHANNEL_ID and CHANNEL_IDS are missing", () => {
  withEnv({ DISCORD_TOKEN: "token123" }, () => {
    throws(
      () => loadConfig(),
      Error,
      "Missing required environment variable: CHANNEL_ID or CHANNEL_IDS",
    );
  });
});

test("loadConfig returns config when required vars are present", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_ID: "my-channel",
    },
    () => {
      const config = loadConfig();
      expect(config.discordToken).toStrictEqual("my-token");
      expect(config.channelId).toStrictEqual("my-channel");
      expect(config.channelIds).toStrictEqual(["my-channel"]);
    },
  );
});

test("loadConfig accepts CHANNEL_IDS without CHANNEL_ID", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_IDS: "chan-1, chan-2",
    },
    () => {
      const config = loadConfig();
      expect(config.channelId).toStrictEqual("chan-1");
      expect(config.channelIds).toStrictEqual(["chan-1", "chan-2"]);
    },
  );
});

test("loadConfig appends CHANNEL_ID when CHANNEL_IDS is provided and missing it", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_IDS: "chan-1, chan-2",
      CHANNEL_ID: "chan-3",
    },
    () => {
      const config = loadConfig();
      expect(config.channelId).toStrictEqual("chan-1");
      expect(config.channelIds).toStrictEqual(["chan-1", "chan-2", "chan-3"]);
    },
  );
});

// =============================================================================
// loadConfig - Optional Variables with Defaults
// =============================================================================

test("loadConfig uses default TIME_ZONE when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      expect(config.timeZone).toStrictEqual("America/Los_Angeles");
    },
  );
});

test("loadConfig uses custom TIME_ZONE when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      TIME_ZONE: "Europe/London",
    },
    () => {
      const config = loadConfig();
      expect(config.timeZone).toStrictEqual("Europe/London");
    },
  );
});

test("loadConfig uses default GLUE_ALERT_THRESHOLD when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      expect(config.glueAlertThreshold).toStrictEqual(7);
    },
  );
});

test("loadConfig uses custom GLUE_ALERT_THRESHOLD when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      GLUE_ALERT_THRESHOLD: "3",
    },
    () => {
      const config = loadConfig();
      expect(config.glueAlertThreshold).toStrictEqual(3);
    },
  );
});

test("loadConfig returns complete config with all values", () => {
  withEnv(
    {
      DISCORD_TOKEN: "secret-token",
      CHANNEL_ID: "123456789",
      TIME_ZONE: "Asia/Tokyo",
      GLUE_ALERT_THRESHOLD: "5",
      AI_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-key",
      AI_RATE_LIMIT_PER_USER: "10",
      AI_DAILY_TOKEN_BUDGET: "50000",
      AI_MAX_INPUT_CHARS: "300",
      ENABLE_UWU: "false",
      AI_CONTEXT_MAX_MESSAGES: "75",
      AI_CONTEXT_INACTIVITY_MINUTES: "15",
      WEB_SEARCH_ENABLED: "true",
      BRAVE_SEARCH_API_KEY: "brave-key",
      WEB_SEARCH_MAX_RESULTS: "5",
      LINK_OPEN_ENABLED: "false",
      AUTONOMOUS_CHAT_ENABLED: "true",
      AUTONOMOUS_CHAT_CHANNEL_IDS: "auto-1, auto-2",
      AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES: "6",
      AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES: "25",
      AUTONOMOUS_CHAT_COOLDOWN_MINUTES: "45",
      AUTONOMOUS_CHAT_REPLY_CHANCE: "0.2",
      AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES: "60",
    },
    () => {
      const config = loadConfig();
      expect(config).toStrictEqual({
        discordToken: "secret-token",
        adminHttpToken: undefined,
        channelId: "123456789",
        channelIds: ["123456789"],
        timeZone: "Asia/Tokyo",
        glueAlertThreshold: 5,
        aiEnabled: true,
        openaiApiKey: "sk-test-key",
        openaiAdminKey: undefined,
        usageOpenaiProjectId: undefined,
        aiRateLimitPerUser: 10,
        aiDailyTokenBudget: 50000,
        aiMaxInputChars: 300,
        aiEnableUwu: false,
        aiContextMaxMessages: 75,
        aiContextInactivityMinutes: 15,
        webSearchEnabled: true,
        webSearchApiKey: "brave-key",
        webSearchMaxResults: 5,
        linkOpenEnabled: false,
        discordActionsEnabled: true,
        discordActionsGuildIds: [],
        autonomousChatEnabled: true,
        autonomousChatChannelIds: ["auto-1", "auto-2"],
        autonomousChatMinHumanMessages: 6,
        autonomousChatActivityWindowMinutes: 25,
        autonomousChatCooldownMinutes: 45,
        autonomousChatReplyChance: 0.2,
        autonomousChatMaxContextMessages: 60,
        autonomousChatSettleSeconds: 8,
      });
    },
  );
});

test("Discord actions can be disabled or restricted to selected servers", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "123",
      DISCORD_ACTIONS_ENABLED: "false",
      DISCORD_ACTIONS_GUILD_IDS: " sandbox, another, ",
    },
    () => {
      const config = loadConfig();
      expect(config.discordActionsEnabled).toStrictEqual(false);
      expect(config.discordActionsGuildIds).toStrictEqual(["sandbox", "another"]);
    },
  );
});

test("loadConfig uses AI defaults when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      expect(config.aiEnabled).toStrictEqual(true);
      expect(config.openaiApiKey).toStrictEqual(undefined);
      expect(config.aiRateLimitPerUser).toStrictEqual(2); // 2 per minute
      expect(config.aiDailyTokenBudget).toStrictEqual(10000000); // 10M tokens, user has OpenAI spending limits
      expect(config.aiMaxInputChars).toStrictEqual(0); // disabled by default
      expect(config.aiEnableUwu).toStrictEqual(true);
      expect(config.aiContextMaxMessages).toStrictEqual(40);
      expect(config.aiContextInactivityMinutes).toStrictEqual(20);
      expect(config.channelIds).toStrictEqual(["channel"]);
      expect(config.webSearchEnabled).toStrictEqual(false);
      expect(config.webSearchApiKey).toStrictEqual(undefined);
      expect(config.webSearchMaxResults).toStrictEqual(3);
      expect(config.linkOpenEnabled).toStrictEqual(true);
      expect(config.autonomousChatEnabled).toStrictEqual(false);
      expect(config.autonomousChatChannelIds).toStrictEqual(["channel"]);
      expect(config.autonomousChatMinHumanMessages).toStrictEqual(4);
      expect(config.autonomousChatActivityWindowMinutes).toStrictEqual(20);
      expect(config.autonomousChatCooldownMinutes).toStrictEqual(1);
      expect(config.autonomousChatReplyChance).toStrictEqual(0.35);
      expect(config.autonomousChatMaxContextMessages).toStrictEqual(40);
    },
  );
});

test("loadConfig defaults AUTONOMOUS_CHAT_CHANNEL_IDS to configured channels", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_IDS: "chan-1, chan-2",
    },
    () => {
      const config = loadConfig();
      expect(config.autonomousChatChannelIds).toStrictEqual(["chan-1", "chan-2"]);
    },
  );
});

test("loadConfig supports AUTONOMOUS_CHAT_CHANNEL_IDS override", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_IDS: "chan-1, chan-2",
      AUTONOMOUS_CHAT_CHANNEL_IDS: "auto-1, auto-2, auto-1",
    },
    () => {
      const config = loadConfig();
      expect(config.channelIds).toStrictEqual(["chan-1", "chan-2"]);
      expect(config.autonomousChatChannelIds).toStrictEqual(["auto-1", "auto-2"]);
    },
  );
});

test("loadConfig handles AI_ENABLED=false", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AI_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      expect(config.aiEnabled).toStrictEqual(false);
    },
  );
});

test("loadConfig enables web search when API key is set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      BRAVE_SEARCH_API_KEY: "brave-key",
    },
    () => {
      const config = loadConfig();
      expect(config.webSearchEnabled).toStrictEqual(true);
      expect(config.webSearchApiKey).toStrictEqual("brave-key");
    },
  );
});

test("loadConfig allows WEB_SEARCH_ENABLED=false to override key", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      BRAVE_SEARCH_API_KEY: "brave-key",
      WEB_SEARCH_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      expect(config.webSearchEnabled).toStrictEqual(false);
    },
  );
});

test("loadConfig handles LINK_OPEN_ENABLED=false", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      LINK_OPEN_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      expect(config.linkOpenEnabled).toStrictEqual(false);
    },
  );
});

test("loadConfig clamps AUTONOMOUS_CHAT_REPLY_CHANCE", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AUTONOMOUS_CHAT_REPLY_CHANCE: "2",
    },
    () => {
      const config = loadConfig();
      expect(config.autonomousChatReplyChance).toStrictEqual(1);
    },
  );
});

test("loadConfig defaults invalid AUTONOMOUS_CHAT_REPLY_CHANCE", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AUTONOMOUS_CHAT_REPLY_CHANCE: "sometimes",
    },
    () => {
      const config = loadConfig();
      expect(config.autonomousChatReplyChance).toStrictEqual(0.35);
    },
  );
});

test("HTTP administration is disabled by default and accepts an explicit token", () => {
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "123" }, () => {
    expect(loadConfig().adminHttpToken).toStrictEqual(undefined);
  });
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "123", ADMIN_HTTP_TOKEN: "  " }, () => {
    expect(loadConfig().adminHttpToken).toStrictEqual(undefined);
  });
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "123", ADMIN_HTTP_TOKEN: "secret" }, () => {
    expect(loadConfig().adminHttpToken).toStrictEqual("secret");
  });
});

test("usage billing configuration is separate from the chat key and trims blank values", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      OPENAI_API_KEY: "chat-key",
      OPENAI_ADMIN_KEY: " admin-key ",
      USAGE_OPENAI_PROJECT_ID: " proj-test ",
    },
    () => {
      const config = loadConfig();
      expect(config.openaiAdminKey).toStrictEqual("admin-key");
      expect(config.usageOpenaiProjectId).toStrictEqual("proj-test");
      expect(config.openaiApiKey).toStrictEqual("chat-key");
    },
  );
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      OPENAI_ADMIN_KEY: " ",
      USAGE_OPENAI_PROJECT_ID: " ",
    },
    () => {
      const config = loadConfig();
      expect(config.openaiAdminKey).toStrictEqual(undefined);
      expect(config.usageOpenaiProjectId).toStrictEqual(undefined);
    },
  );
});
