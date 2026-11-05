/** Cron jobs, all scheduled in UTC whatever the process time zone is. */
import type { AppConfig } from "../config.ts";
import type { AiService } from "../ai/types.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { StorageService } from "../services/storage.ts";
import { createAutonomousChatJob } from "../jobs/autonomous_chat.ts";
import { collectExpiredPolls } from "../jobs/collect_polls.ts";
import { postMoodPolls } from "../jobs/mood_poll.ts";
import { postStats } from "../jobs/stats.ts";
import { runWellnessCheck } from "../jobs/wellness.ts";

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

  // 05:00 UTC is 21:00 PST / 22:00 PDT.
  cron("Daily Retro Poll", "0 5 * * *", async () => {
    console.log("[CRON] Starting scheduled poll job...");
    await postMoodPolls(deps, dateFormatter, "[CRON]");
  });
  cron("Daily Wellness Check", "0 6 * * *", async () => {
    console.log("[CRON] Starting wellness check...");
    await runWellnessCheck(deps);
  });
  cron("Weekly Stats Summary", "0 6 * * SUN", async () => {
    console.log("[CRON] Starting weekly stats summary...");
    await postStats(deps, {
      days: 7,
      title: "📊 Weekly Mood Summary",
      label: "weekly stats",
      tag: "[CRON]",
    });
  });
  cron("Poll Result Collection", "30 * * * *", async () => {
    console.log("[CRON] Checking for expired polls to collect...");
    const result = await collectExpiredPolls(discord, storage);
    console.log(
      `[CRON] Poll collection: ${result.collected.length} collected, ${result.failed.length} pending retry`,
    );
  });
  cron("Autonomous Chat", "* * * * *", createAutonomousChatJob(deps, aiService, rateLimit));
  cron("Maintenance", "15 * * * *", maintenance);

  console.log("[CRON] Registered jobs:");
  console.log("  - Daily Retro Poll (05:00 UTC)");
  console.log("  - Daily Wellness Check (06:00 UTC)");
  console.log("  - Weekly Stats Summary (Sundays 06:00 UTC)");
  console.log("  - Poll Result Collection (every hour at :30)");
  console.log("  - Autonomous Chat (every minute, disabled unless configured)");
  console.log("  - Maintenance (every hour at :15)");
}
