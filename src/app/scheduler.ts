/** Cron jobs, all scheduled in UTC whatever the process time zone is. */
import type { AiService } from "../ai/types.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { LandmineService } from "../features/landmine.ts";
import type { JobDeps } from "../jobs/channel_posts.ts";
import { createAutonomousChatJob } from "../jobs/autonomous_chat.ts";
import { collectExpiredPolls } from "../jobs/collect_polls.ts";
import { postLandmineReport } from "../jobs/landmine_report.ts";
import { postMoodPolls } from "../jobs/mood_poll.ts";
import { postStats } from "../jobs/stats.ts";
import { runWellnessCheck } from "../jobs/wellness.ts";
import { log } from "./log.ts";

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
        log.error("cron", `${name} failed`, { error });
      }
    },
    { tz: "UTC" },
  );
};

export function registerCronJobs(
  cron: CronRegistrar,
  {
    ai,
    rateLimit,
    landmines,
    ...deps
  }: JobDeps & { ai: AiService; rateLimit: RateLimitService; landmines: LandmineService },
  maintenance: () => void = () => {},
): void {
  const { discord, storage } = deps;
  const schedules: Record<string, string> = {};
  const register: CronRegistrar = (name, schedule, handler) => {
    schedules[name] = schedule;
    cron(name, schedule, handler);
  };

  // 05:00 UTC is 21:00 PST / 22:00 PDT.
  register("Daily Retro Poll", "0 5 * * *", async () => {
    log.info("cron", "Starting scheduled poll job");
    await postMoodPolls(deps, "cron");
  });
  register("Daily Wellness Check", "0 6 * * *", async () => {
    log.info("cron", "Starting wellness check");
    await runWellnessCheck(deps);
  });
  register("Weekly Stats Summary", "0 6 * * SUN", async () => {
    log.info("cron", "Starting weekly stats summary");
    await postStats(deps, {
      days: 7,
      title: "📊 Weekly Mood Summary",
      label: "weekly stats",
      scope: "cron",
    });
  });
  register("Weekly Landmine Report", "0 6 * * SUN", async () => {
    await postLandmineReport(deps, landmines, "week");
  });
  register("Monthly Landmine Report", "0 6 1 * *", async () => {
    await postLandmineReport(deps, landmines, "month");
  });
  register("Poll Result Collection", "30 * * * *", async () => {
    log.info("poll", "Checking for expired polls to collect");
    const result = await collectExpiredPolls(discord, storage);
    log.info("poll", "Poll collection", {
      collected: result.collected.length,
      pendingRetry: result.failed.length,
    });
  });
  register("Autonomous Chat", "* * * * *", createAutonomousChatJob(deps, ai, rateLimit));
  register("Maintenance", "15 * * * *", maintenance);

  log.info("cron", "Registered jobs", { schedules, timeZone: "UTC" });
}
