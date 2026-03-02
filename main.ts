import { loadConfig } from "./src/config.ts";
import { createDiscordClient } from "./src/services/discord.ts";
import { createStorageService } from "./src/services/storage.ts";
import { createRateLimitService } from "./src/services/rate_limit.ts";
import { createWebSearchService } from "./src/services/web_search.ts";
import { createLinkOpenService } from "./src/services/link_open.ts";
import { createAiService } from "./ai_service.ts";
import { createServer } from "./src/server.ts";
import { registerCronJobs } from "./src/scheduler.ts";
import { startGateway } from "./discord_gateway.ts";
import type { BotDependencies } from "./bot_actions.ts";

// --- Initialization ---
// Throws immediately if required env vars are missing (Fail Fast pattern)
const config = loadConfig();

// Initialize Deno KV for data persistence
const kv = await Deno.openKv();
const storage = createStorageService(kv);

// Create the Discord API client
const discord = createDiscordClient(config.discordToken);

// Create AI-related services
const rate_limit = createRateLimitService(kv, config);
const ai_service = createAiService(config);
const web_search = createWebSearchService(config);
const link_open = createLinkOpenService(config);

// Bundle dependencies for bot actions
const bot_deps: BotDependencies = {
  config,
  aiService: ai_service,
  rateLimitService: rate_limit,
  linkOpenService: link_open,
  webSearchService: web_search,
};

// Set up the date formatter with configured timezone
const date_formatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: config.timeZone,
});

// --- Register Services ---
startGateway(config, bot_deps);
registerCronJobs(config, discord, storage, date_formatter);
createServer(config, discord, storage, date_formatter, rate_limit);

// --- Startup Logging ---
console.log("🐴 Haru is running!");
console.log(`   Channels: ${config.channelIds.join(", ")}`);
console.log(`   Timezone: ${config.timeZone}`);
console.log(`   Glue Alert Threshold: ${config.glueAlertThreshold} days`);
console.log("");
console.log("🤖 AI Configuration:");
console.log(`   Enabled: ${config.aiEnabled}`);
console.log(`   Rate Limit: ${config.aiRateLimitPerUser} requests/user/minute`);
console.log(`   Daily Token Budget: ${config.aiDailyTokenBudget.toLocaleString()} tokens`);
const max_input_label = config.aiMaxInputChars > 0 ? String(config.aiMaxInputChars) : "unlimited";
console.log(`   Max Input Chars: ${max_input_label}`);
console.log(`   UwU Mode: ${config.aiEnableUwu}`);
if (!config.openaiApiKey) {
  console.log("   ⚠️  OPENAI_API_KEY not set - AI chat disabled");
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
