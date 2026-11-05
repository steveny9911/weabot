/** Per-channel AI context: the current conversation, cached in memory between reads. */
import type { AppConfig } from "../config.ts";
import { fetchChannelMessages } from "../discord/messages.ts";
import {
  mapDiscordMessage,
  toAiContextMessage,
  selectActiveConversation,
} from "../features/chat_context.ts";

// In-memory cache of recent messages per channel
const messagesCache = new Map<string, Array<Record<string, unknown>>>();

/**
 * Fetch the most recent N messages from a channel and cache them.
 */
export async function saveContext(
  config: AppConfig,
  channelId: string,
  limit = 5,
  triggerMessage?: Record<string, unknown>,
  options: { inactivityGapMs?: number; resetAfterMs?: number | null } = {},
): Promise<void> {
  if (!channelId) return;

  try {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const fetched = await fetchChannelMessages(config, channelId, safeLimit);
    if (!fetched) return;
    let msgs = fetched;

    // Ensure the triggering message is included
    if (triggerMessage) {
      const trigId = triggerMessage["id"] as string | undefined;
      if (trigId) {
        msgs = msgs.filter((m) => (m.id as string | undefined) !== trigId);
      }
      msgs.push(triggerMessage);
    }

    const activeConversation = selectActiveConversation(msgs.map(mapDiscordMessage), {
      maxMessages: safeLimit,
      inactivityGapMs: options.inactivityGapMs ?? config.aiContextInactivityMinutes * 60_000,
      resetAfterMs: options.resetAfterMs,
    });
    const simplified = activeConversation.map(toAiContextMessage);

    messagesCache.set(channelId, simplified as Array<Record<string, unknown>>);
    console.log(`Saved ${simplified.length} messages to context for channel ${channelId}`);
  } catch (err) {
    console.error("Error saving context:", err);
  }
}

/**
 * Retrieve cached context for a channel.
 */
export function getContext(channelId: string): Array<Record<string, unknown>> | undefined {
  return messagesCache.get(channelId);
}

/** Forget the cached context for a channel, as the \\reset command does. */
export function clearContext(channelId: string): void {
  messagesCache.delete(channelId);
}
