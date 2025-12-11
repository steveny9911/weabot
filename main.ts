/**
 * Weabot - Discord Mental Health Reflection Bot
 *
 * Entry point that wires all modules together:
 * 1. Load and validate configuration
 * 2. Create API clients
 * 3. Register scheduled jobs
 * 4. Start the HTTP server
 */

import { loadConfig } from "./src/config.ts";
import { createDiscordClient } from "./src/services/discord.ts";
import { createServer } from "./src/server.ts";
import { registerCronJobs } from "./src/scheduler.ts";

// --- Initialization ---
// Throws immediately if required env vars are missing (Fail Fast pattern)
const config = loadConfig();

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
registerCronJobs(config, discord, dateFormatter);
createServer(config, discord, dateFormatter);

console.log("🐴 Weabot is running!");
