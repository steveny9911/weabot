/**
 * Scheduler Module
 *
 * Registers cron jobs for scheduled tasks:
 * - Daily mood poll (05:00 UTC)
 * - Daily wellness check (06:00 UTC, 1 hour after poll)
 * - Weekly stats summary (Sundays at 06:00 UTC)
 * - Poll result collection (every hour at :30)
 * - Autonomous chat (every minute)
 * - Maintenance (every hour at :15)
 *
 * Schedules are in UTC whatever the process time zone is.
 */

import type { AppConfig } from "../config.ts";
import type { AiService } from "../ai/service.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { StorageService } from "../services/storage.ts";
import { createAutonomousChatJob } from "../jobs/autonomous_chat.ts";
import { collectExpiredPolls } from "../jobs/collect_polls.ts";
import { postMoodPolls } from "../jobs/mood_poll.ts";
import { postStats } from "../jobs/stats.ts";
import { runWellnessCheck } from "../jobs/wellness.ts";

/** Registers one job. The production registrar is {@link bunCron}; tests pass a fake. */
export type CronRegistrar = (
  name: string,
  schedule: string,
  handler: () => Promise<void> | void,
) => void;

/** Runs jobs in this process with `Bun.cron` in UTC. A failing job is logged, not fatal. */
export const bunCron: CronRegistrar = (name, schedule, handler) => {
  Bun.cron(
    schedule,
    async () => {
      try {
        await handler();
      } catch (error) {
        console.error(`[CRON] ${name} failed:`, error);
      }
    },
    { tz: "UTC" },
  );
};

/**
 * Registers all cron jobs for the application.
 *
 * @param cron - Job registrar
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param storage - Storage service for vote data
 * @param dateFormatter - Date formatter for poll questions
 * @param aiService - AI service for autonomous chat replies
 * @param rateLimit - Rate limit service for AI budget tracking
 * @param maintenance - Hourly retention clean-up
 */
export function registerCronJobs(
  cron: CronRegistrar,
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
  aiService: AiService,
  rateLimit: RateLimitService,
  maintenance: () => void = () => {},
): void {
  const deps = { config, discord, storage };
  const autonomousChat = createAutonomousChatJob(deps, aiService, rateLimit);

  // =========================================================================
  // Daily Mood Poll
  // Schedule: 05:00 UTC = 21:00 PST / 22:00 PDT
  // =========================================================================
  cron("Daily Retro Poll", "0 5 * * *", async () => {
    console.log("[CRON] Starting scheduled poll job...");

    try {
      await postMoodPolls(deps, dateFormatter, "[CRON]");
    } catch (error) {
      console.error("[CRON] Error posting poll:", error);
    }
  });

  // =========================================================================
  // Daily Wellness Check (Glue Alerts)
  // Schedule: 06:00 UTC = 22:00 PST / 23:00 PDT (1 hour after poll)
  // Checks if any user has consecutive "glue" days and sends supportive message
  // =========================================================================
  cron("Daily Wellness Check", "0 6 * * *", async () => {
    console.log("[CRON] Starting wellness check...");

    try {
      await runWellnessCheck(deps);
    } catch (error) {
      console.error("[CRON] Error in wellness check:", error);
    }
  });

  // =========================================================================
  // Weekly Stats Summary
  // Schedule: Sundays at 06:00 UTC
  // Posts a summary of the week's mood trends
  // =========================================================================
  cron("Weekly Stats Summary", "0 6 * * SUN", async () => {
    console.log("[CRON] Starting weekly stats summary...");

    try {
      await postStats(deps, {
        days: 7,
        title: "📊 Weekly Mood Summary",
        label: "weekly stats",
        tag: "[CRON]",
      });
    } catch (error) {
      console.error("[CRON] Error posting weekly stats:", error);
    }
  });

  // =========================================================================
  // Poll Result Collection
  // Schedule: Every hour at :30 minutes
  // Checks for expired polls and collects their results
  // =========================================================================
  cron("Poll Result Collection", "30 * * * *", async () => {
    console.log("[CRON] Checking for expired polls to collect...");

    try {
      const result = await collectExpiredPolls(discord, storage);
      console.log(
        `[CRON] Poll collection: ${result.collected.length} collected, ${result.failed.length} pending retry`,
      );
    } catch (error) {
      console.error("[CRON] Error in poll collection:", error);
    }
  });

  // =========================================================================
  // Autonomous Chat
  // Schedule: Every minute
  // =========================================================================
  cron("Autonomous Chat", "* * * * *", autonomousChat);

  // =========================================================================
  // Maintenance
  // Schedule: Every hour at :15
  // Deletes old AI usage rows and expired in-memory Discord action turns.
  // =========================================================================
  cron("Maintenance", "15 * * * *", () => {
    try {
      maintenance();
    } catch (error) {
      console.error("[CRON] Error in maintenance:", error);
    }
  });

  console.log("[CRON] Registered jobs:");
  console.log("  - Daily Retro Poll (05:00 UTC)");
  console.log("  - Daily Wellness Check (06:00 UTC)");
  console.log("  - Weekly Stats Summary (Sundays 06:00 UTC)");
  console.log("  - Poll Result Collection (every hour at :30)");
  console.log("  - Autonomous Chat (every minute, disabled unless configured)");
  console.log("  - Maintenance (every hour at :15)");
}
