/** Per-channel AI context: the current conversation, read fresh from Discord for each mention. */
import type { AppConfig } from "../config.ts";
import type { DiscordClient } from "../discord/client.ts";
import {
  mapDiscordMessage,
  toAiContextMessage,
  selectActiveConversation,
  type RecentDiscordMessage,
} from "../features/chat_context.ts";
import { log } from "../app/log.ts";

/** The recent conversation ending with `triggerMessage`; just the trigger if Discord fails. */
export async function loadContext(
  discord: Pick<DiscordClient, "getRecentMessages">,
  config: AppConfig,
  channelId: string,
  triggerMessage: Record<string, unknown>,
  resetAfterMs?: number,
): Promise<Array<Record<string, unknown>>> {
  const trigger = mapDiscordMessage(triggerMessage);
  const limit = config.aiContextMaxMessages;
  let recent: RecentDiscordMessage[] = [];
  try {
    recent = await discord.getRecentMessages(channelId, limit);
  } catch (err) {
    log.error("bot", "Error loading context", { error: err });
  }
  const conversation = selectActiveConversation(
    [...recent.filter((m) => m.id !== trigger.id), trigger],
    {
      maxMessages: limit,
      inactivityGapMs: config.aiContextInactivityMinutes * 60_000,
      resetAfterMs,
    },
  );
  log.debug("bot", "Loaded context", { channelId, messages: conversation.length });
  return conversation.map(toAiContextMessage) as Array<Record<string, unknown>>;
}
