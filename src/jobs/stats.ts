/** Posts a mood stats embed covering the last `days` UTC calendar days to every channel. */
import { buildStatsEmbed } from "../features/stats.ts";
import type { ChannelPost, JobDeps, LogTag } from "./channel_posts.ts";

export interface StatsPostOptions {
  days: number;
  title: string;
  /** Lower-case name used in logs, such as "weekly stats". */
  label: string;
  tag: LogTag;
}

export async function postStats(
  { config, discord, storage }: JobDeps,
  { days, title, label, tag }: StatsPostOptions,
): Promise<ChannelPost[]> {
  const endDate = new Date();
  const startDate = new Date(endDate);
  // UTC calendar days, so the window is the same in any process time zone.
  startDate.setUTCDate(startDate.getUTCDate() - days);
  const capitalized = label[0].toUpperCase() + label.slice(1);
  const posts: ChannelPost[] = [];

  for (const channelId of config.channelIds) {
    const stats = await storage.getStats(
      channelId,
      startDate.toISOString().split("T")[0],
      endDate.toISOString().split("T")[0],
    );
    const embed = buildStatsEmbed(stats, title);
    const response = await discord.postMessage(channelId, embed);

    if (response.ok) {
      console.log(`${tag} ${capitalized} posted in ${channelId}!`);
      posts.push({ channelId, ok: true, detail: "" });
    } else {
      const body = await response.text();
      console.error(`${tag} Failed to post ${label} in ${channelId}: ${response.status}`);
      console.error(body);
      posts.push({ channelId, ok: false, detail: body });
    }
  }
  return posts;
}
