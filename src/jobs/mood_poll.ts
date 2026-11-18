/** Posts the daily mood poll to the mood_poll channels and records it for later collection. */
import { buildMoodPollPayload } from "../features/poll.ts";
import { MOOD_POLL_HOURS } from "../types/bot.ts";
import { type ChannelPost, type JobDeps, postToChannels } from "./channel_posts.ts";
import { log, type LogScope } from "../app/log.ts";

export async function postMoodPolls(
  { config, discord, storage }: JobDeps,
  scope: LogScope,
): Promise<ChannelPost[]> {
  if (!config.moodPoll.enabled) {
    log.debug(scope, "Mood poll skipped because it is disabled");
    return [];
  }
  const now = Date.now();
  const title = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: config.timeZone });
  const payload = buildMoodPollPayload(title.format(now));
  return await postToChannels(
    discord,
    config.moodPoll.channelIds,
    { label: "poll", scope },
    () => payload,
    ({ channelId, detail: messageId }) =>
      storage.savePendingPoll({
        messageId,
        channelId,
        date: new Date(now).toISOString().slice(0, 10),
        createdAt: now,
        expiresAt: now + MOOD_POLL_HOURS * 60 * 60 * 1000,
        collected: false,
      }),
  );
}
