import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./src/config.ts";
import { createDiscordClient } from "./src/discord/client.ts";
import { createDiscordEventsClient } from "./src/discord/events.ts";
import {
  createDiscordActionService,
  type PendingRequest,
} from "./src/features/discord_actions/service.ts";
import { TurnStore } from "./src/features/discord_actions/state.ts";
import { openDatabase } from "./src/db/database.ts";
import { createMaintenanceJob } from "./src/jobs/maintenance.ts";
import { createStorageService } from "./src/services/storage.ts";
import { createRateLimitService } from "./src/services/rate_limit.ts";
import { createWebSearchService } from "./src/net/web_search.ts";
import { createTweetService } from "./src/net/tweet.ts";
import { createLandmineQueries } from "./src/db/landmines.ts";
import { createLandmineService } from "./src/features/landmine.ts";
import { createGachaPityQueries } from "./src/db/gacha_pity.ts";
import { createGachaService } from "./src/features/gacha.ts";
import { createRngQueries } from "./src/db/rng.ts";
import { createRngService } from "./src/features/rng.ts";
import { createLinkOpenService } from "./src/net/link_open.ts";
import { createAiService } from "./src/ai/service.ts";
import { createServer } from "./src/app/server.ts";
import { bunCron, registerCronJobs } from "./src/app/scheduler.ts";
import { startGateway } from "./src/app/gateway.ts";
import { log, setLogLevel } from "./src/app/log.ts";
import type { ChannelScope } from "./src/feature_config.ts";
import type { BotDependencies } from "./src/bot/handle_message.ts";

// A crash is logged like everything else, then the process exits so Docker restarts it.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error) => {
    log.error("main", event, { error });
    process.exit(1);
  });
}

const config = loadConfig();
setLogLevel(config.logLevel);

const channelsLabel = (channelIds: ChannelScope) => (channelIds === "all" ? "all" : channelIds);

const db = openDatabase(config.databasePath);
const storage = createStorageService(db);
const actionTurns = new TurnStore<PendingRequest>();

const discord = createDiscordClient(config.discordToken);

const rateLimit = createRateLimitService(db, config);
const aiService = createAiService(config);
const webSearch = createWebSearchService(config);
const linkOpen = createLinkOpenService();
const tweets = createTweetService();

// Next to the database, so in Docker it lands in the writable ./data volume.
const gachaCacheDir = join(resolve(dirname(config.databasePath)), "gacha-cache");

const landmineService = createLandmineService({
  config,
  mines: createLandmineQueries(db),
  discord,
});
if (config.landmine.enabled) {
  log.info("landmine", "Landmines ready", {
    chance: config.landmine.chance,
    percent: Number((config.landmine.chance * 100).toFixed(2)),
    stepPenalty: config.landmine.stepPenalty,
    remaining: createLandmineQueries(db).remaining(),
  });
}

const botDeps: BotDependencies = {
  config,
  discord,
  aiService,
  rateLimitService: rateLimit,
  linkOpenService: linkOpen,
  storageService: storage,
  webSearchService: webSearch,
  tweetService: tweets,
  gachaService: createGachaService({
    cacheDir: gachaCacheDir,
    pity: createGachaPityQueries(db),
    cooldownMs: config.gacha.cooldownSeconds * 1000,
    renderTimeoutMs: config.gacha.timeoutSeconds * 1000,
    queueSize: config.gacha.queueSize,
  }),
  rngService: createRngService({
    queries: createRngQueries(db),
    digits: config.rng.digits,
    timeZone: config.timeZone,
  }),
  landmineService,
  discordActionService: createDiscordActionService(
    createDiscordEventsClient(config.discordToken),
    db,
    config.timeZone,
    undefined,
    actionTurns,
  ),
};

startGateway(config, botDeps);
const jobDeps = { config, discord, storage, rateLimit };
registerCronJobs(
  bunCron,
  { ...jobDeps, ai: aiService, landmines: landmineService },
  createMaintenanceJob(db, actionTurns),
);
createServer(jobDeps, config.httpPort);

const features = {
  mentionReplies: config.aiChat,
  webSearch: config.webSearch,
  linkOpen: config.linkOpen,
  tweetRead: config.tweetRead,
  gacha: config.gacha,
  rng: config.rng,
  discordActions: config.discordActions,
  autonomousChat: config.autonomousChat,
  landmines: config.landmine,
  moodPoll: config.moodPoll,
  weeklyStats: config.weeklyStats,
  wellness: config.wellness,
};
log.info("main", "Haru is running", {
  channels: config.channelIds,
  database: config.databasePath,
  timeZone: config.timeZone,
  logLevel: config.logLevel,
});
log.info("AI", "AI configuration", {
  enabled: config.aiEnabled,
  provider: config.aiProvider ?? "none",
  rateLimitPerUser: config.aiRateLimitPerUser,
  dailyTokenBudget: config.aiDailyTokenBudget.toLocaleString(),
  maxInputChars: config.aiMaxInputChars > 0 ? config.aiMaxInputChars.toLocaleString() : "unlimited",
  uwu: config.aiEnableUwu,
  contextMaxMessages: config.aiContextMaxMessages,
  contextInactivityMinutes: config.aiContextInactivityMinutes,
});
log.info(
  "main",
  "Features",
  Object.fromEntries(
    Object.entries(features).map(([name, feature]) => [
      name,
      feature.enabled ? channelsLabel(feature.channelIds) : "off",
    ]),
  ),
);
if (config.aiProvider && !config.aiApiKey) {
  log.warn("main", `${config.aiApiKeyEnv} not set; AI chat is disabled`);
}
if (config.webSearch.enabled && !config.webSearch.apiKey) {
  log.warn("main", "BRAVE_SEARCH_API_KEY not set; web search will fail");
}
