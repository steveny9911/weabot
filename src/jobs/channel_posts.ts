/** Shared shape for jobs that post to their feature's channels. */
import type { AppConfig } from "../config.ts";
import type { DiscordClient, MessagePayload } from "../discord/client.ts";
import type { StorageService } from "../services/storage.ts";

export interface JobDeps {
  config: AppConfig;
  discord: DiscordClient;
  storage: StorageService;
}

/** Log prefix of the caller: scheduled jobs log as [CRON], admin routes as [SERVER]. */
export type LogTag = "[CRON]" | "[SERVER]";

/** One channel's result. `detail` is the new message ID on success, Discord's error body otherwise. */
export interface ChannelPost {
  channelId: string;
  ok: boolean;
  detail: string;
}

/**
 * Posts to each channel in turn, logging every result as `tag` and naming the post `label`.
 * `onPosted` runs right after each successful post, so a later channel failing cannot lose it.
 */
export async function postToChannels(
  discord: DiscordClient,
  channelIds: string[],
  { label, tag }: { label: string; tag: LogTag },
  payloadFor: (channelId: string) => MessagePayload | Promise<MessagePayload>,
  onPosted?: (post: ChannelPost) => void | Promise<void>,
): Promise<ChannelPost[]> {
  const posts: ChannelPost[] = [];
  for (const channelId of channelIds) {
    const response = await discord.postMessage(channelId, await payloadFor(channelId));
    if (response.ok) {
      const { id } = (await response.json()) as { id: string };
      console.log(`${tag} Posted ${label} in ${channelId}: message ${id}`);
      const post = { channelId, ok: true, detail: id };
      posts.push(post);
      await onPosted?.(post);
    } else {
      const body = await response.text();
      console.error(`${tag} Failed to post ${label} in ${channelId}: ${response.status} ${body}`);
      posts.push({ channelId, ok: false, detail: body });
    }
  }
  return posts;
}
