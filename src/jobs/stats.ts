/** Posts a mood stats embed covering the last `days` UTC calendar days to the weekly_stats channels. */
import { buildStatsEmbed } from "../features/stats.ts";
import { type ChannelPost, type JobDeps, type LogTag, postToChannels } from "./channel_posts.ts";

export interface StatsPostOptions {
  days: number;
  title: string;
  /** Name used in logs, such as "weekly stats". */
  label: string;
  tag: LogTag;
}

/** The UTC dates from `days` days ago through today, both ends inclusive (as stats always were). */
export function lastDays(days: number, now = new Date()): { start: string; end: string } {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

export async function postStats(
  { config, discord, storage }: JobDeps,
  { days, title, label, tag }: StatsPostOptions,
): Promise<ChannelPost[]> {
  if (!config.weeklyStats.enabled) {
    console.log(`${tag} Stats skipped because weekly stats are disabled`);
    return [];
  }
  const { start, end } = lastDays(days);
  return await postToChannels(
    discord,
    config.weeklyStats.channelIds,
    { label, tag },
    async (channelId) => buildStatsEmbed(await storage.getStats(channelId, start, end), title),
  );
}
