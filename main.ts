import { createUsageService } from "./src/services/usage.ts";
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
import { createLinkOpenService } from "./src/net/link_open.ts";
import { createAiService } from "./src/ai/service.ts";
import { createServer } from "./src/app/server.ts";
import { bunCron, registerCronJobs } from "./src/app/scheduler.ts";
import { startGateway } from "./src/app/gateway.ts";
import type { ChannelScope, FeatureConfig } from "./src/feature_config.ts";
import type { BotDependencies } from "./src/bot/handle_message.ts";

const config = loadConfig();

const channelsLabel = (channelIds: ChannelScope) =>
  channelIds === "all" ? "all" : channelIds.join(", ");
const onOff = (feature: FeatureConfig) =>
  `${feature.enabled ? "on" : "off"}, channels: ${channelsLabel(feature.channelIds)}`;

const db = openDatabase(config.databasePath);
const storage = createStorageService(db);
const actionTurns = new TurnStore<PendingRequest>();

const discord = createDiscordClient(config.discordToken);

const rateLimit = createRateLimitService(db, config);
const aiService = createAiService(config);
const webSearch = createWebSearchService(config);
const linkOpen = createLinkOpenService(config);
const tweets = createTweetService();

const botDeps: BotDependencies = {
  config,
  discord,
  usageService: createUsageService(config),
  aiService,
  rateLimitService: rateLimit,
  linkOpenService: linkOpen,
  storageService: storage,
  webSearchService: webSearch,
  tweetService: tweets,
  landmineService: createLandmineService({ config, mines: createLandmineQueries(db), discord }),
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
registerCronJobs(bunCron, { ...jobDeps, ai: aiService }, createMaintenanceJob(db, actionTurns));
createServer(jobDeps, config.httpPort);

console.log("🐴 Haru is running!");
console.log(`   Channels: ${config.channelIds.join(", ")}`);
console.log(`   Database: ${config.databasePath}`);
console.log(`   Timezone: ${config.timeZone}`);
console.log("");
console.log("🤖 AI Configuration:");
console.log(`   Enabled: ${config.aiEnabled}`);
console.log(`   Provider: ${config.aiProvider}`);
console.log(`   Rate Limit: ${config.aiRateLimitPerUser} requests/user/minute`);
console.log(`   Daily Token Budget: ${config.aiDailyTokenBudget.toLocaleString()} tokens`);
const maxInputLabel = config.aiMaxInputChars > 0 ? String(config.aiMaxInputChars) : "unlimited";
console.log(`   Max Input Chars: ${maxInputLabel}`);
console.log(`   UwU Mode: ${config.aiEnableUwu}`);
console.log(`   Context Limit: ${config.aiContextMaxMessages} messages`);
console.log(`   Context Inactivity Gap: ${config.aiContextInactivityMinutes} minutes`);
if (!config.aiApiKey) {
  console.log("   ⚠️  AI_API_KEY not set - AI chat disabled");
}

console.log("");
console.log("🧩 Features:");
const features = {
  "Mention replies": config.aiChat,
  "Web search": config.webSearch,
  "Link open": config.linkOpen,
  "Tweet reading": config.tweetRead,
  "Event/invite actions": config.discordActions,
  "Autonomous chat": config.autonomousChat,
  Landmines: config.landmine,
  "Mood poll": config.moodPoll,
  "Weekly stats": config.weeklyStats,
  "Wellness alerts": config.wellness,
};
for (const [name, feature] of Object.entries(features)) {
  console.log(`   ${name}: ${onOff(feature)}`);
}
if (config.webSearch.enabled && !config.webSearch.apiKey) {
  console.log("   ⚠️  BRAVE_SEARCH_API_KEY not set - web search will fail");
}
