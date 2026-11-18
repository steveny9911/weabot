/** Wellness alerts: the daily check for users with consecutive "glue" days, and a manual test alert. */
import { buildAlertEmbed } from "../features/stats.ts";
import { type ChannelPost, type JobDeps, postToChannels } from "./channel_posts.ts";
import { log } from "../app/log.ts";

/** Sends a supportive alert for each user at or over the configured "glue" streak. */
export async function runWellnessCheck({ config, discord, storage }: JobDeps): Promise<void> {
  if (!config.wellness.enabled) {
    log.debug("cron", "Wellness check skipped because it is disabled");
    return;
  }
  for (const channelId of config.wellness.channelIds) {
    const atRisk = await storage.getUsersAtRisk(channelId, config.wellness.glueAlertThreshold);

    if (atRisk.length === 0) {
      log.info("cron", "No users at risk", { channelId });
      continue;
    }

    log.info("cron", "Users at risk", { channelId, count: atRisk.length });

    for (const history of atRisk) {
      const name = history[0].userName;
      await postToChannels(
        discord,
        [channelId],
        { label: `alert for ${name}`, scope: "cron" },
        () => buildAlertEmbed(name, history.length),
      );
    }
  }
}

/** Posts an alert for a named (test) user to the wellness channels, whatever the vote history says. */
export async function postTestAlert(
  { config, discord }: JobDeps,
  userName: string,
  days: number,
): Promise<ChannelPost[]> {
  if (!config.wellness.enabled) {
    log.debug("server", "Test alert skipped because wellness is disabled");
    return [];
  }
  const alertEmbed = buildAlertEmbed(userName, days);
  return await postToChannels(
    discord,
    config.wellness.channelIds,
    { label: "alert", scope: "server" },
    () => alertEmbed,
  );
}
