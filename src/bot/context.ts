/** Per-channel AI context: the current conversation, cached in memory between reads. */
import type { AppConfig } from "../config.ts";
import { fetchChannelMessages } from "../discord/messages.ts";
import {
  oMapDiscordMessage,
  oToAiContextMessage,
  selectActiveConversation,
} from "../features/chat_context.ts";

// In-memory cache of recent messages per channel
const messages_cache = new Map<string, Array<Record<string, unknown>>>();

/**
 * Fetch the most recent N messages from a channel and cache them.
 */
export async function saveContext(
  config: AppConfig,
  channel_id: string,
  limit = 5,
  trigger_message?: Record<string, unknown>,
  options: { inactivityGapMs?: number; resetAfterMs?: number | null } = {},
): Promise<void> {
  if (!channel_id) return;

  try {
    const safe_limit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const fetched = await fetchChannelMessages(config, channel_id, safe_limit);
    if (!fetched) return;
    let msgs = fetched;

    // Ensure the triggering message is included
    if (trigger_message) {
      const trig_id = trigger_message["id"] as string | undefined;
      if (trig_id) {
        msgs = msgs.filter((m) => (m.id as string | undefined) !== trig_id);
      }
      msgs.push(trigger_message);
    }

    const active_conversation = selectActiveConversation(msgs.map(oMapDiscordMessage), {
      maxMessages: safe_limit,
      inactivityGapMs: options.inactivityGapMs ?? config.aiContextInactivityMinutes * 60_000,
      resetAfterMs: options.resetAfterMs,
    });
    const simplified = active_conversation.map(oToAiContextMessage);

    messages_cache.set(channel_id, simplified as Array<Record<string, unknown>>);
    console.log(`Saved ${simplified.length} messages to context for channel ${channel_id}`);
  } catch (err) {
    console.error("Error saving context:", err);
  }
}

/**
 * Retrieve cached context for a channel.
 */
export function getContext(channel_id: string): Array<Record<string, unknown>> | undefined {
  return messages_cache.get(channel_id);
}

/** Forget the cached context for a channel, as the \\reset command does. */
export function clearContext(channel_id: string): void {
  messages_cache.delete(channel_id);
}
