/** Posts the daily mood poll to the mood_poll channels and records it for later collection. */
import { buildMoodPollPayload } from "../features/poll.ts";
import { MOOD_POLL_HOURS } from "../types/bot.ts";
import { type ChannelPost, type JobDeps, type LogTag, postToChannels } from "./channel_posts.ts";

export async function postMoodPolls(
  { config, discord, storage }: JobDeps,
  tag: LogTag,
): Promise<ChannelPost[]> {
  if (!config.moodPoll.enabled) {
    console.log(`${tag} Mood poll skipped because it is disabled`);
    return [];
  }
  const now = Date.now();
  const title = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: config.timeZone });
  const payload = buildMoodPollPayload(title.format(now));
  const posts = await postToChannels(
    discord,
    config.moodPoll.channelIds,
    { label: "poll", tag },
    () => payload,
  );
  for (const { channelId, ok, detail: messageId } of posts) {
    if (!ok) continue;
    await storage.savePendingPoll({
      messageId,
      channelId,
      date: new Date(now).toISOString().slice(0, 10),
      createdAt: now,
      expiresAt: now + MOOD_POLL_HOURS * 60 * 60 * 1000,
      collected: false,
    });
  }
  return posts;
}
