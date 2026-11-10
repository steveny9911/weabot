import { expect, test } from "bun:test";
import { throws } from "../tests/support/assert.ts";
import { loadConfig, type ConfigFile } from "./config.ts";

const SECRETS = [
  "DISCORD_TOKEN",
  "ADMIN_HTTP_TOKEN",
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "BRAVE_SEARCH_API_KEY",
];

/** Runs `fn` with exactly these secrets in the environment. */
function withSecrets(secrets: Record<string, string>, fn: () => void) {
  const saved = Object.fromEntries(SECRETS.map((name) => [name, process.env[name]]));
  for (const name of SECRETS) delete process.env[name];
  Object.assign(process.env, secrets);
  try {
    fn();
  } finally {
    for (const name of SECRETS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Loads `file` with a Discord token and, unless the file sets one, a channel. */
function load(file: ConfigFile = {}, secrets: Record<string, string> = {}) {
  let config!: ReturnType<typeof loadConfig>;
  withSecrets({ DISCORD_TOKEN: "token", ...secrets }, () => {
    config = loadConfig({ discord: { channel_ids: ["chan-1"] }, ...file });
  });
  return config;
}

test("loadConfig needs a Discord token and a channel", () => {
  withSecrets({}, () => {
    throws(
      () => loadConfig({ discord: { channel_ids: ["c"] } }),
      Error,
      "Missing required environment variable: DISCORD_TOKEN",
    );
  });
  withSecrets({ DISCORD_TOKEN: "t" }, () => {
    throws(() => loadConfig({}), Error, "Missing channel: set discord.channel_ids in config.yaml");
  });
});

test("an empty config.yaml gives the defaults", () => {
  const config = load();
  expect(config.channelIds).toStrictEqual(["chan-1"]);
  expect(config.channelId).toStrictEqual("chan-1");
  expect(config.databasePath).toStrictEqual("./data/haru.sqlite3");
  expect(config.httpPort).toStrictEqual(8000);
  expect(config.timeZone).toStrictEqual("America/Los_Angeles");
  expect(config.glueAlertThreshold).toStrictEqual(7);
  expect(config.aiEnabled).toStrictEqual(true);
  expect(config.aiProvider).toStrictEqual("openai");
  expect(config.aiModels).toStrictEqual([]);
  expect(config.aiSystemPromptFile).toBeUndefined();
  expect(config.aiThinking).toStrictEqual(false);
  expect(config.aiRateLimitPerUser).toStrictEqual(2);
  expect(config.aiDailyTokenBudget).toStrictEqual(10_000_000);
  expect(config.aiDailyRequestQuota).toBeUndefined();
  expect(config.aiDailyRequestPercent).toStrictEqual(90);
  expect(config.aiMaxInputChars).toStrictEqual(0);
  expect(config.aiEnableUwu).toStrictEqual(true);
  expect(config.aiContextMaxMessages).toStrictEqual(40);
  expect(config.aiContextInactivityMinutes).toStrictEqual(20);
  expect(config.usageOpenaiProjectId).toBeUndefined();
  expect(config.webSearchEnabled).toStrictEqual(false);
  expect(config.webSearchMaxResults).toStrictEqual(3);
  expect(config.linkOpenEnabled).toStrictEqual(true);
  expect(config.tweetReadEnabled).toStrictEqual(true);
  expect(config.discordActionsEnabled).toStrictEqual(true);
  expect(config.discordActionsGuildIds).toStrictEqual([]);
  expect(config.autonomousChatEnabled).toStrictEqual(false);
  expect(config.autonomousChatChannelIds).toStrictEqual(["chan-1"]);
  expect(config.autonomousChatMinHumanMessages).toStrictEqual(4);
  expect(config.autonomousChatActivityWindowMinutes).toStrictEqual(20);
  expect(config.autonomousChatCooldownMinutes).toStrictEqual(1);
  expect(config.autonomousChatReplyChance).toStrictEqual(0.35);
  expect(config.autonomousChatMaxContextMessages).toStrictEqual(40);
  expect(config.autonomousChatRequestPercent).toStrictEqual(30);
  expect(config.landmineEnabled).toStrictEqual(false);
  expect(config.landmineChannelIds).toStrictEqual(["chan-1"]);
  expect(config.landmineChance).toStrictEqual(0.1);
  expect(config.landmineTimeoutEnabled).toStrictEqual(true);
  expect(config.landmineTimeoutSeconds).toStrictEqual(60);
  expect(config.landmineGifs).toStrictEqual([]);
});

test("settings come from config.yaml", () => {
  const config = load(
    Bun.YAML.parse(`
discord:
  channel_ids: ["chan-5", "chan-5", "chan-6"]
  actions: { enabled: false, guild_ids: ["guild-1"] }
general: { db_path: /tmp/x.sqlite3, http_port: 9000, time_zone: America/Vancouver }
ai:
  provider: gemini
  models: [model-a, model-b, model-a]
  system_prompt_file: persona.md
  thinking: true
  uwu: false
  context: { max_messages: 10 }
  budget: { daily_request_quota: 500, mention_percent: 80 }
features:
  web_search: { enabled: true, max_results: 5 }
  tweet_read: false
usage: { openai_project_id: proj-1 }
autonomous_chat:
  enabled: true
  channel_ids: ["chan-7"]
  reply_chance: 0.6
  cooldown_minutes: 5
landmine:
  enabled: true
  channel_ids: ["chan-8"]
  chance: 0.25
  gifs: [https://a.example/1.gif]
  timeout: { enabled: false, seconds: 30 }
`) as ConfigFile,
  );
  expect(config.channelIds).toStrictEqual(["chan-5", "chan-6"]);
  expect(config.discordActionsEnabled).toStrictEqual(false);
  expect(config.discordActionsGuildIds).toStrictEqual(["guild-1"]);
  expect(config.databasePath).toStrictEqual("/tmp/x.sqlite3");
  expect(config.httpPort).toStrictEqual(9000);
  expect(config.timeZone).toStrictEqual("America/Vancouver");
  expect(config.aiProvider).toStrictEqual("gemini");
  expect(config.aiModels).toStrictEqual(["model-a", "model-b"]);
  expect(config.aiSystemPromptFile).toStrictEqual("persona.md");
  expect(config.aiThinking).toStrictEqual(true);
  expect(config.aiEnableUwu).toStrictEqual(false);
  expect(config.aiContextMaxMessages).toStrictEqual(10);
  expect(config.aiDailyRequestQuota).toStrictEqual(500);
  expect(config.aiDailyRequestPercent).toStrictEqual(80);
  expect(config.webSearchEnabled).toStrictEqual(true);
  expect(config.webSearchMaxResults).toStrictEqual(5);
  expect(config.tweetReadEnabled).toStrictEqual(false);
  expect(config.usageOpenaiProjectId).toStrictEqual("proj-1");
  expect(config.autonomousChatEnabled).toStrictEqual(true);
  expect(config.autonomousChatChannelIds).toStrictEqual(["chan-7"]);
  expect(config.autonomousChatReplyChance).toStrictEqual(0.6);
  expect(config.autonomousChatCooldownMinutes).toStrictEqual(5);
  expect(config.landmineEnabled).toStrictEqual(true);
  expect(config.landmineChannelIds).toStrictEqual(["chan-8"]);
  expect(config.landmineChance).toStrictEqual(0.25);
  expect(config.landmineGifs).toStrictEqual(["https://a.example/1.gif"]);
  expect(config.landmineTimeoutEnabled).toStrictEqual(false);
  expect(config.landmineTimeoutSeconds).toStrictEqual(30);
});

test("null values in config.yaml use the defaults", () => {
  const config = load(
    Bun.YAML.parse("ai: { budget: { daily_request_quota: null } }") as ConfigFile,
  );
  expect(config.aiDailyRequestQuota).toBeUndefined();
});

test("context messages and landmine timeouts are capped at their limits", () => {
  const config = load({
    ai: { context: { max_messages: 500 } },
    landmine: { timeout: { seconds: 9e9 } },
  });
  expect(config.aiContextMaxMessages).toStrictEqual(100);
  expect(config.landmineTimeoutSeconds).toStrictEqual(28 * 86_400);
});

test("an unknown AI provider fails at startup", () => {
  withSecrets({ DISCORD_TOKEN: "t" }, () => {
    throws(
      () => loadConfig({ discord: { channel_ids: ["c"] }, ai: { provider: "claude" } }),
      Error,
      "Unknown ai.provider: claude",
    );
  });
});

test("channel and server IDs must be quoted strings", () => {
  const unquoted = Bun.YAML.parse("channel_ids: [1568100184754360470]") as ConfigFile["discord"];
  withSecrets({ DISCORD_TOKEN: "t" }, () => {
    throws(
      () => loadConfig({ discord: unquoted }),
      Error,
      "discord.channel_ids in config.yaml must be a list of quoted strings",
    );
  });
});

test("secrets come from the environment and empty ones count as unset", () => {
  const config = load(
    {},
    { ADMIN_HTTP_TOKEN: "", OPENAI_ADMIN_KEY: "admin", BRAVE_SEARCH_API_KEY: "" },
  );
  expect(config.adminHttpToken).toBeUndefined();
  expect(config.openaiAdminKey).toStrictEqual("admin");
  expect(config.webSearchApiKey).toBeUndefined();
  expect(config.webSearchEnabled).toStrictEqual(false);
});

test("web search turns on when a Brave key is set, unless config.yaml says otherwise", () => {
  const secrets = { BRAVE_SEARCH_API_KEY: "key" };
  expect(load({}, secrets).webSearchEnabled).toStrictEqual(true);
  expect(load({ features: { web_search: { enabled: false } } }, secrets).webSearchEnabled).toBe(
    false,
  );
});

test("AI_API_KEY wins, and OPENAI_API_KEY only works for the openai provider", () => {
  expect(load({}, { OPENAI_API_KEY: "old" }).aiApiKey).toStrictEqual("old");
  expect(load({}, { AI_API_KEY: "new", OPENAI_API_KEY: "old" }).aiApiKey).toStrictEqual("new");
  expect(load({ ai: { provider: "gemini" } }, { OPENAI_API_KEY: "old" }).aiApiKey).toBeUndefined();
});
