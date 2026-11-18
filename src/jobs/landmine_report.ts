/** Posts the landmine leaderboard to the landmine report channels. */
import type { LandmineService } from "../features/landmine.ts";
import type { ReportPeriod } from "../features/landmine_report.ts";
import { type ChannelPost, type JobDeps, postToChannels } from "./channel_posts.ts";
import { log } from "../app/log.ts";

export async function postLandmineReport(
  { config, discord }: Pick<JobDeps, "config" | "discord">,
  landmines: LandmineService,
  period: ReportPeriod,
): Promise<ChannelPost[]> {
  const label = `${period}ly landmine report`;
  if (!config.landmine.enabled) {
    log.debug("landmine", `Skipped the ${label} because landmines are disabled`);
    return [];
  }
  const report = landmines.report(period);
  return await postToChannels(
    discord,
    config.landmine.reportChannelIds,
    { label, scope: "cron" },
    () => report,
  );
}
