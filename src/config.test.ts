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
  expect(config.databasePath).toStrictEqual("./data/haru.sqlite3");
  expect(config.httpPort).toStrictEqual(8000);
  expect(config.timeZone).toStrictEqual("America/Los_Angeles");
  expect(config.moodPoll).toStrictEqual({ enabled: true, channelIds: ["chan-1"] });
  expect(config.wellness).toStrictEqual({
    enabled: true,
    channelIds: ["chan-1"],
    glueAlertThreshold: 7,
  });
  expect(config.weeklyStats).toStrictEqual({ enabled: true, channelIds: ["chan-1"] });
  expect(config.aiEnabled).toStrictEqual(true);
  expect(config.aiChat).toStrictEqual({ enabled: true, channelIds: ["chan-1"] });
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
  expect(config.webSearch).toStrictEqual({
    enabled: false,
    channelIds: ["chan-1"],
    apiKey: undefined,
    maxResults: 3,
  });
  expect(config.linkOpen).toStrictEqual({ enabled: true, channelIds: ["chan-1"] });
  expect(config.tweetRead).toStrictEqual({ enabled: true, channelIds: ["chan-1"] });
  expect(config.discordActions).toStrictEqual({
    enabled: true,
    channelIds: ["chan-1"],
    guildIds: [],
  });
  expect(config.autonomousChat).toStrictEqual({
    enabled: false,
    channelIds: ["chan-1"],
    minHumanMessages: 4,
    activityWindowMinutes: 20,
    cooldownMinutes: 1,
    replyChance: 0.35,
    settleSeconds: 8,
    maxContextMessages: 40,
    requestPercent: 30,
  });
  expect(config.landmine).toStrictEqual({
    enabled: false,
    channelIds: ["chan-1"],
    chance: 0.1,
    timeout: { enabled: true, seconds: 60 },
    gifs: [],
  });
});

test("settings come from config.yaml", () => {
  const config = load(
    Bun.YAML.parse(`
discord:
  channel_ids: ["chan-5", "chan-5", "chan-6"]
general: { db_path: /tmp/x.sqlite3, http_port: 9000, time_zone: America/Vancouver }
ai:
  provider: gemini
  models: [model-a, model-b, model-a]
  system_prompt_file: persona.md
  thinking: true
  uwu: false
  context: { max_messages: 10 }
  budget: { daily_request_quota: 500, mention_percent: 80 }
ai_chat: { enabled: false, channel_ids: ["chan-4"] }
web_search: { enabled: true, max_results: 5, channel_ids: all }
tweet_read: { enabled: false }
link_open: { channel_ids: ["chan-9"] }
discord_actions: { enabled: false, guild_ids: ["guild-1"] }
usage: { openai_project_id: proj-1 }
mood_poll: { enabled: false, channel_ids: ["chan-2"] }
wellness: { channel_ids: ["chan-3"], glue_alert_threshold: 3 }
weekly_stats: { enabled: false }
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
  expect(config.discordActions).toStrictEqual({
    enabled: false,
    channelIds: ["chan-5", "chan-6"],
    guildIds: ["guild-1"],
  });
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
  expect(config.aiChat).toStrictEqual({ enabled: false, channelIds: ["chan-4"] });
  expect(config.webSearch).toMatchObject({ enabled: true, channelIds: "all", maxResults: 5 });
  expect(config.tweetRead.enabled).toStrictEqual(false);
  expect(config.linkOpen).toStrictEqual({ enabled: true, channelIds: ["chan-9"] });
  expect(config.usageOpenaiProjectId).toStrictEqual("proj-1");
  expect(config.moodPoll).toStrictEqual({ enabled: false, channelIds: ["chan-2"] });
  expect(config.wellness).toStrictEqual({
    enabled: true,
    channelIds: ["chan-3"],
    glueAlertThreshold: 3,
  });
  expect(config.weeklyStats).toStrictEqual({ enabled: false, channelIds: ["chan-5", "chan-6"] });
  expect(config.autonomousChat).toMatchObject({
    enabled: true,
    channelIds: ["chan-7"],
    replyChance: 0.6,
    cooldownMinutes: 5,
  });
  expect(config.landmine).toStrictEqual({
    enabled: true,
    channelIds: ["chan-8"],
    chance: 0.25,
    timeout: { enabled: false, seconds: 30 },
    gifs: ["https://a.example/1.gif"],
  });
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
  expect(config.landmine.timeout.seconds).toStrictEqual(28 * 86_400);
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
  expect(config.webSearch.apiKey).toBeUndefined();
  expect(config.webSearch.enabled).toStrictEqual(false);
});

test("web search turns on when a Brave key is set, unless config.yaml says otherwise", () => {
  const secrets = { BRAVE_SEARCH_API_KEY: "key" };
  expect(load({}, secrets).webSearch.enabled).toStrictEqual(true);
  expect(load({ web_search: { enabled: false } }, secrets).webSearch.enabled).toBe(false);
});

test("AI_API_KEY wins, and OPENAI_API_KEY only works for the openai provider", () => {
  expect(load({}, { OPENAI_API_KEY: "old" }).aiApiKey).toStrictEqual("old");
  expect(load({}, { AI_API_KEY: "new", OPENAI_API_KEY: "old" }).aiApiKey).toStrictEqual("new");
  expect(load({ ai: { provider: "gemini" } }, { OPENAI_API_KEY: "old" }).aiApiKey).toBeUndefined();
});

/** Loads a YAML snippet next to a channel and expects a startup error containing `message`. */
function fails(yaml: string, message: string) {
  const file = Bun.YAML.parse(`discord: { channel_ids: ["c"] }\n${yaml}`) as ConfigFile;
  withSecrets({ DISCORD_TOKEN: "t" }, () => throws(() => loadConfig(file), Error, message));
}

test("channel_ids can be all, and an empty or null list falls back to the bot's channels", () => {
  expect(load({ landmine: { channel_ids: "all" } }).landmine.channelIds).toStrictEqual("all");
  for (const yaml of ["landmine: { channel_ids: [] }", "landmine: { channel_ids: null }"]) {
    expect(load(Bun.YAML.parse(yaml) as ConfigFile).landmine.channelIds).toStrictEqual(["chan-1"]);
  }
});

test("null sections and settings use the defaults", () => {
  const yaml =
    "landmine: null\nautonomous_chat: { enabled: null }\ndiscord_actions: { guild_ids: null }";
  const config = load(Bun.YAML.parse(yaml) as ConfigFile);
  expect(config.landmine.enabled).toStrictEqual(false);
  expect(config.autonomousChat.enabled).toStrictEqual(false);
  expect(config.discordActions.guildIds).toStrictEqual([]);
});

test("startup stops on a setting it cannot use, and says which", () => {
  fails(
    "autonomous_chat: { channel_ids: all }",
    'autonomous_chat.channel_ids in config.yaml cannot be "all"',
  );
  fails("landmine: { channel_ids: [all] }", "write all without brackets");
  fails(
    "landmine: { channel_ids: chan }",
    "landmine.channel_ids in config.yaml must be a list of quoted strings",
  );
  fails(
    "landmine: { channel_ids: [123] }",
    "landmine.channel_ids in config.yaml must be a list of quoted strings",
  );
  fails("landmine: { chanse: 0.5 }", "Unknown setting landmine.chanse");
  fails("landmines: {}", "Unknown setting landmines");
  fails("landmine: true", "landmine in config.yaml must be a section");
  fails(
    "landmine: { timeout: { enabled: 1 } }",
    "landmine.timeout.enabled in config.yaml must be true or false",
  );
});

test("config.example.yaml loads", async () => {
  const example = Bun.YAML.parse(await Bun.file("config.example.yaml").text()) as ConfigFile;
  const config = load({ ...example, discord: { ...example.discord, channel_ids: ["chan-1"] } });
  expect(config.channelIds).toStrictEqual(["chan-1"]);
});
