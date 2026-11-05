/** Wellness alerts: the daily check for users with consecutive "glue" days, and a manual test alert. */
import { buildAlertEmbed } from "../features/stats/mod.ts";
import type { ChannelPost, JobDeps } from "./channel_posts.ts";

/** Sends a supportive alert for each user at or over the configured "glue" streak. */
export async function runWellnessCheck({ config, discord, storage }: JobDeps): Promise<void> {
  for (const channelId of config.channelIds) {
    const atRisk = await storage.getUsersAtRisk(channelId, config.glueAlertThreshold);

    if (atRisk.length === 0) {
      console.log(`[CRON] No users at risk in ${channelId}`);
      continue;
    }

    console.log(`[CRON] Found ${atRisk.length} user(s) at risk in ${channelId}`);

    for (const userHistory of atRisk) {
      const user = userHistory[0];
      const alertEmbed = buildAlertEmbed(user.odUserName, userHistory.length);
      const response = await discord.postMessage(channelId, alertEmbed);

      if (response.ok) {
        console.log(`[CRON] Alert sent for ${user.odUserName} in ${channelId}`);
      } else {
        console.error(`[CRON] Failed to send alert for ${user.odUserName} in ${channelId}`);
      }
    }
  }
}

/** Posts an alert for a named (test) user to every channel, whatever the vote history says. */
export async function postTestAlert(
  { config, discord }: JobDeps,
  userName: string,
  days: number,
): Promise<ChannelPost[]> {
  const alertEmbed = buildAlertEmbed(userName, days);
  const posts: ChannelPost[] = [];

  for (const channelId of config.channelIds) {
    const response = await discord.postMessage(channelId, alertEmbed);

    if (response.ok) {
      console.log(`[SERVER] Alert posted in ${channelId}!`);
      posts.push({ channelId, ok: true, detail: "" });
    } else {
      const body = await response.text();
      console.error(`[SERVER] Failed to post alert in ${channelId}: ${response.status}`);
      posts.push({ channelId, ok: false, detail: body });
    }
  }
  return posts;
}
