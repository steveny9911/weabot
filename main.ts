import { createUsageService } from "./src/services/usage.ts";
import { loadConfig } from "./src/config.ts";
import { createDiscordClient } from "./src/discord/client.ts";
import { createDiscordEventsClient } from "./src/discord/events.ts";
import {
  createDiscordActionService,
  type PendingRequest,
} from "./src/features/discord_actions/service.ts";
import { TurnStore } from "./src/features/discord_actions/state.ts";
import { DEFAULT_DATABASE_PATH, openDatabase } from "./src/db/database.ts";
import { createMaintenanceJob } from "./src/jobs/maintenance.ts";
import { createStorageService } from "./src/services/storage.ts";
import { createRateLimitService } from "./src/services/rate_limit.ts";
import { createWebSearchService } from "./src/net/web_search.ts";
import { createLinkOpenService } from "./src/net/link_open.ts";
import { createAiService } from "./src/ai/service.ts";
import { withProviderLimits } from "./src/ai/providers/index.ts";
import { createServer } from "./src/app/server.ts";
import { bunCron, registerCronJobs } from "./src/app/scheduler.ts";
import { startGateway } from "./src/app/gateway.ts";
import type { BotDependencies } from "./src/bot/handle_message.ts";

const config = withProviderLimits(loadConfig());

const dbPath = process.env.HARU_DB_PATH || DEFAULT_DATABASE_PATH;
const httpPort = Number(process.env.HTTP_PORT) || 8000;
const db = openDatabase(dbPath);
const storage = createStorageService(db);
const actionTurns = new TurnStore<PendingRequest>();

const discord = createDiscordClient(config.discordToken);

const rateLimit = createRateLimitService(db, config);
const aiService = createAiService(config);
const webSearch = createWebSearchService(config);
const linkOpen = createLinkOpenService(config);

const botDeps: BotDependencies = {
  config,
  usageService: createUsageService(config),
  aiService,
  rateLimitService: rateLimit,
  linkOpenService: linkOpen,
  storageService: storage,
  webSearchService: webSearch,
  discordActionService: createDiscordActionService(
    createDiscordEventsClient(config.discordToken),
    db,
    config.timeZone,
    undefined,
    actionTurns,
  ),
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: config.timeZone,
});

startGateway(config, botDeps);
registerCronJobs(
  bunCron,
  config,
  discord,
  storage,
  dateFormatter,
  aiService,
  rateLimit,
  createMaintenanceJob(db, actionTurns),
);
createServer(config, discord, storage, dateFormatter, rateLimit, httpPort);

console.log("🐴 Haru is running!");
console.log(`   Channels: ${config.channelIds.join(", ")}`);
console.log(`   Database: ${dbPath}`);
console.log(`   Timezone: ${config.timeZone}`);
console.log(`   Glue Alert Threshold: ${config.glueAlertThreshold} days`);
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
console.log(`   Discord Event/Invite Actions: ${config.discordActionsEnabled}`);
if (!config.aiApiKey) {
  console.log("   ⚠️  AI_API_KEY not set - AI chat disabled");
}

console.log("");
console.log("🌐 Web Search:");
console.log(`   Enabled: ${config.webSearchEnabled}`);
console.log(`   Max Results: ${config.webSearchMaxResults}`);
if (!config.webSearchApiKey) {
  console.log("   ⚠️  BRAVE_SEARCH_API_KEY not set - web search disabled");
}
console.log("");
console.log("🔗 Link Open:");
console.log(`   Enabled: ${config.linkOpenEnabled}`);
console.log("");
console.log("💬 Autonomous Chat:");
console.log(`   Enabled: ${config.autonomousChatEnabled}`);
console.log(`   Channels: ${config.autonomousChatChannelIds.join(", ")}`);
console.log(`   Min Human Messages: ${config.autonomousChatMinHumanMessages}`);
console.log(`   Activity Window: ${config.autonomousChatActivityWindowMinutes} minutes`);
console.log(`   Cooldown: ${config.autonomousChatCooldownMinutes} minutes`);
console.log(`   Reply Chance: ${config.autonomousChatReplyChance}`);
console.log(`   Max Context Messages: ${config.autonomousChatMaxContextMessages}`);
