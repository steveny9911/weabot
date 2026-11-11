/** Per-channel AI context: the current conversation, read fresh from Discord for each mention. */
import type { AppConfig } from "../config.ts";
import type { DiscordClient } from "../discord/client.ts";
import {
  mapDiscordMessage,
  toAiContextMessage,
  selectActiveConversation,
  type RecentDiscordMessage,
} from "../features/chat_context.ts";

/** The recent conversation ending with `triggerMessage`; just the trigger if Discord fails. */
export async function loadContext(
  discord: Pick<DiscordClient, "getRecentMessages">,
  config: AppConfig,
  channelId: string,
  limit: number,
  triggerMessage: Record<string, unknown>,
  resetAfterMs?: number,
): Promise<Array<Record<string, unknown>>> {
  const trigger = mapDiscordMessage(triggerMessage);
  let recent: RecentDiscordMessage[] = [];
  try {
    recent = await discord.getRecentMessages(channelId, limit);
  } catch (err) {
    console.error("Error loading context:", err);
  }
  const conversation = selectActiveConversation(
    [...recent.filter((m) => m.id !== trigger.id), trigger],
    {
      maxMessages: limit,
      inactivityGapMs: config.aiContextInactivityMinutes * 60_000,
      resetAfterMs,
    },
  );
  console.log(`Loaded ${conversation.length} messages of context for channel ${channelId}`);
  return conversation.map(toAiContextMessage) as Array<Record<string, unknown>>;
}
