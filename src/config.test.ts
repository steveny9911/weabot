/**
 * Tests for Configuration Module
 */

import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

// Helper to run tests with specific env vars
function withEnv(
  envVars: Record<string, string>,
  fn: () => void,
) {
  // Save original values
  const originalValues: Record<string, string | undefined> = {};
  const allKeys = new Set([
    ...Object.keys(envVars),
    "DISCORD_TOKEN",
    "CHANNEL_ID",
    "CHANNEL_IDS",
    "TIME_ZONE",
    "GLUE_ALERT_THRESHOLD",
    "AI_ENABLED",
    "OPENAI_API_KEY",
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
    originalValues[key] = Deno.env.get(key);
    Deno.env.delete(key);
  }

  // Set test values
  for (const [key, value] of Object.entries(envVars)) {
    Deno.env.set(key, value);
  }

  try {
    fn();
  } finally {
    // Restore original values
    for (const key of allKeys) {
      const original = originalValues[key];
      if (original !== undefined) {
        Deno.env.set(key, original);
      } else {
        Deno.env.delete(key);
      }
    }
  }
}

// =============================================================================
// loadConfig - Required Variables
// =============================================================================

Deno.test("loadConfig throws when DISCORD_TOKEN is missing", () => {
  withEnv({ CHANNEL_ID: "123" }, () => {
    assertThrows(
      () => loadConfig(),
      Error,
      "Missing required environment variable: DISCORD_TOKEN",
    );
  });
});

Deno.test("loadConfig throws when CHANNEL_ID and CHANNEL_IDS are missing", () => {
  withEnv({ DISCORD_TOKEN: "token123" }, () => {
    assertThrows(
      () => loadConfig(),
      Error,
      "Missing required environment variable: CHANNEL_ID or CHANNEL_IDS",
    );
  });
});

Deno.test("loadConfig returns config when required vars are present", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_ID: "my-channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.discordToken, "my-token");
      assertEquals(config.channelId, "my-channel");
      assertEquals(config.channelIds, ["my-channel"]);
    },
  );
});

Deno.test("loadConfig accepts CHANNEL_IDS without CHANNEL_ID", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_IDS: "chan-1, chan-2",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.channelId, "chan-1");
      assertEquals(config.channelIds, ["chan-1", "chan-2"]);
    },
  );
});

Deno.test("loadConfig appends CHANNEL_ID when CHANNEL_IDS is provided and missing it", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_IDS: "chan-1, chan-2",
      CHANNEL_ID: "chan-3",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.channelId, "chan-1");
      assertEquals(config.channelIds, ["chan-1", "chan-2", "chan-3"]);
    },
  );
});

// =============================================================================
// loadConfig - Optional Variables with Defaults
// =============================================================================

Deno.test("loadConfig uses default TIME_ZONE when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.timeZone, "America/Los_Angeles");
    },
  );
});

Deno.test("loadConfig uses custom TIME_ZONE when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      TIME_ZONE: "Europe/London",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.timeZone, "Europe/London");
    },
  );
});

Deno.test("loadConfig uses default GLUE_ALERT_THRESHOLD when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.glueAlertThreshold, 7);
    },
  );
});

Deno.test("loadConfig uses custom GLUE_ALERT_THRESHOLD when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      GLUE_ALERT_THRESHOLD: "3",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.glueAlertThreshold, 3);
    },
  );
});

Deno.test("loadConfig returns complete config with all values", () => {
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
      assertEquals(config, {
        discordToken: "secret-token",
        channelId: "123456789",
        channelIds: ["123456789"],
        timeZone: "Asia/Tokyo",
        glueAlertThreshold: 5,
        aiEnabled: true,
        openaiApiKey: "sk-test-key",
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
      });
    },
  );
});

Deno.test("Discord actions can be disabled or restricted to selected servers", () => {
  withEnv({
    DISCORD_TOKEN: "token",
    CHANNEL_ID: "123",
    DISCORD_ACTIONS_ENABLED: "false",
    DISCORD_ACTIONS_GUILD_IDS: " sandbox, another, ",
  }, () => {
    const config = loadConfig();
    assertEquals(config.discordActionsEnabled, false);
    assertEquals(config.discordActionsGuildIds, ["sandbox", "another"]);
  });
});

Deno.test("loadConfig uses AI defaults when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.aiEnabled, true);
      assertEquals(config.openaiApiKey, undefined);
      assertEquals(config.aiRateLimitPerUser, 2); // 2 per minute
      assertEquals(config.aiDailyTokenBudget, 10000000); // 10M tokens, user has OpenAI spending limits
      assertEquals(config.aiMaxInputChars, 0); // disabled by default
      assertEquals(config.aiEnableUwu, true);
      assertEquals(config.aiContextMaxMessages, 40);
      assertEquals(config.aiContextInactivityMinutes, 20);
      assertEquals(config.channelIds, ["channel"]);
      assertEquals(config.webSearchEnabled, false);
      assertEquals(config.webSearchApiKey, undefined);
      assertEquals(config.webSearchMaxResults, 3);
      assertEquals(config.linkOpenEnabled, true);
      assertEquals(config.autonomousChatEnabled, false);
      assertEquals(config.autonomousChatChannelIds, ["channel"]);
      assertEquals(config.autonomousChatMinHumanMessages, 4);
      assertEquals(config.autonomousChatActivityWindowMinutes, 20);
      assertEquals(config.autonomousChatCooldownMinutes, 1);
      assertEquals(config.autonomousChatReplyChance, 0.35);
      assertEquals(config.autonomousChatMaxContextMessages, 40);
    },
  );
});

Deno.test("loadConfig defaults AUTONOMOUS_CHAT_CHANNEL_IDS to configured channels", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_IDS: "chan-1, chan-2",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.autonomousChatChannelIds, ["chan-1", "chan-2"]);
    },
  );
});

Deno.test("loadConfig supports AUTONOMOUS_CHAT_CHANNEL_IDS override", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_IDS: "chan-1, chan-2",
      AUTONOMOUS_CHAT_CHANNEL_IDS: "auto-1, auto-2, auto-1",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.channelIds, ["chan-1", "chan-2"]);
      assertEquals(config.autonomousChatChannelIds, ["auto-1", "auto-2"]);
    },
  );
});

Deno.test("loadConfig handles AI_ENABLED=false", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AI_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.aiEnabled, false);
    },
  );
});

Deno.test("loadConfig enables web search when API key is set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      BRAVE_SEARCH_API_KEY: "brave-key",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.webSearchEnabled, true);
      assertEquals(config.webSearchApiKey, "brave-key");
    },
  );
});

Deno.test("loadConfig allows WEB_SEARCH_ENABLED=false to override key", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      BRAVE_SEARCH_API_KEY: "brave-key",
      WEB_SEARCH_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.webSearchEnabled, false);
    },
  );
});

Deno.test("loadConfig handles LINK_OPEN_ENABLED=false", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      LINK_OPEN_ENABLED: "false",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.linkOpenEnabled, false);
    },
  );
});

Deno.test("loadConfig clamps AUTONOMOUS_CHAT_REPLY_CHANCE", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AUTONOMOUS_CHAT_REPLY_CHANCE: "2",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.autonomousChatReplyChance, 1);
    },
  );
});

Deno.test("loadConfig defaults invalid AUTONOMOUS_CHAT_REPLY_CHANCE", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AUTONOMOUS_CHAT_REPLY_CHANCE: "sometimes",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.autonomousChatReplyChance, 0.35);
    },
  );
});
