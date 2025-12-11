/**
 * Scheduler Module
 *
 * Registers cron jobs for scheduled tasks (e.g., daily polls).
 * Uses the factory pattern to accept dependencies as arguments,
 * making it easier to test or modify behavior.
 */

import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { DEFAULT_MOOD_CONFIG } from "./types/bot.ts";

/**
 * Registers all cron jobs for the application.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param dateFormatter - Date formatter for poll questions
 */
export function registerCronJobs(
  config: AppConfig,
  discord: DiscordClient,
  dateFormatter: Intl.DateTimeFormat,
): void {
  // Daily Mood Poll
  // Schedule: 05:00 UTC = 21:00 PST / 22:00 PDT
  // Cron format: minute hour day month day-of-week
  Deno.cron("Daily Retro Poll", "0 5 * * *", async () => {
    console.log("[CRON] Starting scheduled poll job...");

    try {
      const dateString = dateFormatter.format(new Date());
      const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
      const response = await discord.postMessage(config.channelId, payload);

      if (response.ok) {
        console.log("[CRON] Poll posted successfully!");
      } else {
        const body = await response.text();
        console.error(`[CRON] Failed to post poll: ${response.status}`);
        console.error(body);
      }
    } catch (error) {
      console.error("[CRON] Error posting poll:", error);
    }
  });

  console.log("[CRON] Registered: Daily Retro Poll (05:00 UTC)");
}
