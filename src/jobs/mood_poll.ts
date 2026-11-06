/** Posts the daily mood poll to every configured channel and records it for later collection. */
import { buildMoodPollPayload } from "../features/poll.ts";
import { DEFAULT_MOOD_CONFIG } from "../types/bot.ts";
import type { PollRecord } from "../types/storage.ts";
import type { ChannelPost, JobDeps, LogTag } from "./channel_posts.ts";

export async function postMoodPolls(
  { config, discord, storage }: JobDeps,
  dateFormatter: Intl.DateTimeFormat,
  tag: LogTag,
): Promise<ChannelPost[]> {
  const now = new Date();
  const dateString = dateFormatter.format(now);
  const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
  const posts: ChannelPost[] = [];

  for (const channelId of config.channelIds) {
    const response = await discord.postMessage(channelId, payload);

    if (response.ok) {
      const messageData = (await response.json()) as { id: string };
      const messageId = messageData.id;

      const pollRecord: PollRecord = {
        messageId,
        channelId,
        date: now.toISOString().split("T")[0],
        createdAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_MOOD_CONFIG.durationHours * 60 * 60 * 1000,
        collected: false,
      };

      await storage.savePendingPoll(pollRecord);
      console.log(`${tag} Poll posted in ${channelId}! Message ID: ${messageId}`);
      posts.push({ channelId, ok: true, detail: messageId });
    } else {
      const body = await response.text();
      console.error(`${tag} Failed to post poll in ${channelId}: ${response.status}`);
      console.error(body);
      posts.push({ channelId, ok: false, detail: body });
    }
  }
  return posts;
}
