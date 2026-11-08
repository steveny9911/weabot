import { expect, test } from "bun:test";
import { throws } from "../tests/support/assert.ts";
import { loadConfig } from "./config.ts";

function withEnv(envVars: Record<string, string>, fn: () => void) {
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
    "AI_PROVIDER",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_SYSTEM_PROMPT_FILE",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "USAGE_OPENAI_PROJECT_ID",
    "AI_RATE_LIMIT_PER_USER",
    "AI_DAILY_TOKEN_BUDGET",
    "AI_DAILY_REQUEST_QUOTA",
    "AI_DAILY_REQUEST_PERCENT",
    "AI_MAX_INPUT_CHARS",
    "ENABLE_UWU",
    "AI_CONTEXT_MAX_MESSAGES",
    "AI_CONTEXT_INACTIVITY_MINUTES",
    "WEB_SEARCH_ENABLED",
    "BRAVE_SEARCH_API_KEY",
    "WEB_SEARCH_MAX_RESULTS",
    "LINK_OPEN_ENABLED",
    "TWEET_READ_ENABLED",
    "DISCORD_ACTIONS_ENABLED",
    "DISCORD_ACTIONS_GUILD_IDS",
    "AUTONOMOUS_CHAT_ENABLED",
    "AUTONOMOUS_CHAT_CHANNEL_IDS",
    "AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES",
    "AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES",
    "AUTONOMOUS_CHAT_COOLDOWN_MINUTES",
    "AUTONOMOUS_CHAT_REPLY_CHANCE",
    "AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES",
    "AUTONOMOUS_CHAT_REQUEST_PERCENT",
    "LANDMINE_ENABLED",
    "LANDMINE_CHANNEL_IDS",
    "LANDMINE_CHANCE",
    "LANDMINE_TIMEOUT_ENABLED",
    "LANDMINE_TIMEOUT_SECONDS",
    "LANDMINE_GIFS",
  ]);

  for (const key of allKeys) {
    originalValues[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
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
      TWEET_READ_ENABLED: "false",
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
        aiProvider: "openai",
        aiModel: undefined,
        aiSystemPromptFile: undefined,
        aiThinking: false,
        aiApiKey: "sk-test-key",
        openaiAdminKey: undefined,
        usageOpenaiProjectId: undefined,
        aiRateLimitPerUser: 10,
        aiDailyTokenBudget: 50000,
        aiDailyRequestQuota: undefined,
        aiDailyRequestPercent: 90,
        aiMaxInputChars: 300,
        aiEnableUwu: false,
        aiContextMaxMessages: 75,
        aiContextInactivityMinutes: 15,
        webSearchEnabled: true,
        webSearchApiKey: "brave-key",
        webSearchMaxResults: 5,
        linkOpenEnabled: false,
        tweetReadEnabled: false,
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
        autonomousChatRequestPercent: 30,
        landmineEnabled: false,
        landmineChannelIds: ["123456789"],
        landmineChance: 0.1,
        landmineTimeoutEnabled: true,
        landmineTimeoutSeconds: 60,
        landmineGifs: [],
      });
    },
  );
});

test("the daily request quota is unset by default and its percentages fall back when invalid", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "1",
      AI_DAILY_REQUEST_QUOTA: "100",
      AI_DAILY_REQUEST_PERCENT: "80",
      AUTONOMOUS_CHAT_REQUEST_PERCENT: "150",
    },
    () => {
      const config = loadConfig();
      expect(config.aiDailyRequestQuota).toBe(100);
      expect(config.aiDailyRequestPercent).toBe(80);
      expect(config.autonomousChatRequestPercent).toBe(30);
    },
  );
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", AI_DAILY_REQUEST_QUOTA: "0" }, () => {
    expect(loadConfig().aiDailyRequestQuota).toBeUndefined();
  });
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
      expect(config.aiApiKey).toStrictEqual(undefined);
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
      expect(config.tweetReadEnabled).toStrictEqual(true);
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
      expect(config.aiApiKey).toStrictEqual("chat-key");
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

test("AI provider defaults to OpenAI and AI_API_KEY takes precedence over OPENAI_API_KEY", () => {
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "channel", OPENAI_API_KEY: "old-key" }, () => {
    const config = loadConfig();
    expect(config.aiProvider).toStrictEqual("openai");
    expect(config.aiApiKey).toStrictEqual("old-key");
  });
  withEnv(
    { DISCORD_TOKEN: "token", CHANNEL_ID: "channel", AI_API_KEY: "new-key", OPENAI_API_KEY: "old" },
    () => expect(loadConfig().aiApiKey).toStrictEqual("new-key"),
  );
});

test("an unknown AI_PROVIDER fails at startup", () => {
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "channel", AI_PROVIDER: "nope" }, () => {
    throws(() => loadConfig(), Error, "Unknown AI_PROVIDER: nope");
  });
});

test("AI_MODEL, AI_SYSTEM_PROMPT_FILE and AI_THINKING are read", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      AI_PROVIDER: "gemini",
      AI_MODEL: " models/gemini-test ",
      AI_SYSTEM_PROMPT_FILE: "data/system_prompt.md",
      AI_THINKING: "true",
    },
    () => {
      const config = loadConfig();
      expect(config.aiProvider).toStrictEqual("gemini");
      expect(config.aiThinking).toBe(true);
      expect(config.aiModel).toStrictEqual("models/gemini-test");
      expect(config.aiSystemPromptFile).toStrictEqual("data/system_prompt.md");
    },
  );
});

test("landmines are off by default and use the bot channels, 10% and 60 seconds", () => {
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_IDS: "1,2" }, () => {
    const config = loadConfig();
    expect(config.landmineEnabled).toBe(false);
    expect(config.landmineChannelIds).toStrictEqual(["1", "2"]);
    expect(config.landmineChance).toBe(0.1);
    expect(config.landmineTimeoutEnabled).toBe(true);
    expect(config.landmineTimeoutSeconds).toBe(60);
    expect(config.landmineGifs).toStrictEqual([]);
  });
});

test("landmine settings are read, and invalid values fall back or are clamped", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "1",
      LANDMINE_ENABLED: "true",
      LANDMINE_CHANNEL_IDS: "7, 8",
      LANDMINE_CHANCE: "0.5",
      LANDMINE_TIMEOUT_SECONDS: "9999999",
    },
    () => {
      const config = loadConfig();
      expect(config.landmineEnabled).toBe(true);
      expect(config.landmineChannelIds).toStrictEqual(["7", "8"]);
      expect(config.landmineChance).toBe(0.5);
      expect(config.landmineTimeoutSeconds).toBe(28 * 86_400);
    },
  );
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_CHANCE: "2" }, () => {
    expect(loadConfig().landmineChance).toBe(1);
  });
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_CHANCE: "oops" }, () => {
    expect(loadConfig().landmineChance).toBe(0.1);
  });
  for (const timeout of ["0", "-5", "abc"]) {
    withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_TIMEOUT_SECONDS: timeout }, () => {
      expect(loadConfig().landmineTimeoutSeconds).toBe(60);
    });
  }
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_CHANNEL_IDS: " , " }, () => {
    expect(loadConfig().landmineChannelIds).toStrictEqual(["1"]);
  });
});

test("landmine timeouts can be turned off", () => {
  withEnv({ DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_TIMEOUT_ENABLED: "false" }, () => {
    expect(loadConfig().landmineTimeoutEnabled).toBe(false);
  });
});

test("landmine GIFs are a comma-separated list", () => {
  withEnv(
    { DISCORD_TOKEN: "token", CHANNEL_ID: "1", LANDMINE_GIFS: "https://a.gif, https://b.gif," },
    () => {
      expect(loadConfig().landmineGifs).toStrictEqual(["https://a.gif", "https://b.gif"]);
    },
  );
});
