/**
 * Scheduler Module
 *
 * Registers cron jobs for scheduled tasks:
 * - Daily mood poll (05:00 UTC)
 * - Daily wellness check (06:00 UTC, 1 hour after poll)
 * - Weekly stats summary (Sundays at 06:00 UTC)
 */

import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { StorageService } from "./services/storage.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { buildAlertEmbed, buildStatsEmbed } from "./features/stats/mod.ts";
import { DEFAULT_MOOD_CONFIG } from "./types/bot.ts";

/**
 * Registers all cron jobs for the application.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param storage - Storage service for vote data
 * @param dateFormatter - Date formatter for poll questions
 */
export function registerCronJobs(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
): void {
  // =========================================================================
  // Daily Mood Poll
  // Schedule: 05:00 UTC = 21:00 PST / 22:00 PDT
  // =========================================================================
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

  // =========================================================================
  // Daily Wellness Check (Glue Alerts)
  // Schedule: 06:00 UTC = 22:00 PST / 23:00 PDT (1 hour after poll)
  // Checks if any user has consecutive "glue" days and sends supportive message
  // =========================================================================
  Deno.cron("Daily Wellness Check", "0 6 * * *", async () => {
    console.log("[CRON] Starting wellness check...");

    try {
      const atRisk = await storage.getUsersAtRisk(config.glueAlertThreshold);

      if (atRisk.length === 0) {
        console.log("[CRON] No users at risk. Everyone is doing okay! 🎉");
        return;
      }

      console.log(`[CRON] Found ${atRisk.length} user(s) at risk`);

      for (const userHistory of atRisk) {
        const user = userHistory[0];
        const alertEmbed = buildAlertEmbed(user.odUserName, userHistory.length);

        const response = await discord.postMessage(config.channelId, alertEmbed);

        if (response.ok) {
          console.log(`[CRON] Alert sent for ${user.odUserName}`);
        } else {
          console.error(`[CRON] Failed to send alert for ${user.odUserName}`);
        }
      }
    } catch (error) {
      console.error("[CRON] Error in wellness check:", error);
    }
  });

  // =========================================================================
  // Weekly Stats Summary
  // Schedule: Sundays at 06:00 UTC
  // Posts a summary of the week's mood trends
  // =========================================================================
  Deno.cron("Weekly Stats Summary", "0 6 * * SUN", async () => {
    console.log("[CRON] Starting weekly stats summary...");

    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      const stats = await storage.getStats(
        startDate.toISOString().split("T")[0],
        endDate.toISOString().split("T")[0],
      );

      const embed = buildStatsEmbed(stats, "📊 Weekly Mood Summary");
      const response = await discord.postMessage(config.channelId, embed);

      if (response.ok) {
        console.log("[CRON] Weekly stats posted successfully!");
      } else {
        const body = await response.text();
        console.error(`[CRON] Failed to post weekly stats: ${response.status}`);
        console.error(body);
      }
    } catch (error) {
      console.error("[CRON] Error posting weekly stats:", error);
    }
  });

  console.log("[CRON] Registered jobs:");
  console.log("  - Daily Retro Poll (05:00 UTC)");
  console.log("  - Daily Wellness Check (06:00 UTC)");
  console.log("  - Weekly Stats Summary (Sundays 06:00 UTC)");
}
