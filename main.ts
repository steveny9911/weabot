/**
 * Weabot - Discord Mental Health Reflection Bot
 *
 * Entry point that wires all modules together:
 * 1. Load and validate configuration
 * 2. Initialize storage (Deno KV)
 * 3. Create API clients
 * 4. Register scheduled jobs
 * 5. Start the HTTP server
 */

import { loadConfig } from "./src/config.ts";
import { createDiscordClient } from "./src/services/discord.ts";
import { createStorageService } from "./src/services/storage.ts";
import { createServer } from "./src/server.ts";
import { registerCronJobs } from "./src/scheduler.ts";

// --- Initialization ---
// Throws immediately if required env vars are missing (Fail Fast pattern)
const config = loadConfig();

// Initialize Deno KV for data persistence
const kv = await Deno.openKv();
const storage = createStorageService(kv);

// Create the Discord API client
const discord = createDiscordClient(config.discordToken);

// Set up the date formatter with configured timezone
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: config.timeZone,
});

// --- Register Services ---
registerCronJobs(config, discord, storage, dateFormatter);
createServer(config, discord, storage, dateFormatter);

console.log("🐴 Weabot is running!");
console.log(`   Channel: ${config.channelId}`);
console.log(`   Timezone: ${config.timeZone}`);
console.log(`   Glue Alert Threshold: ${config.glueAlertThreshold} days`);
