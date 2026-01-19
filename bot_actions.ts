/**
 * Bot Actions
 *
 * Handles incoming Discord messages and AI-powered responses.
 * Uses dependency injection for testability and rate limiting.
 */

import type { AppConfig } from "./src/config.ts";
import type { AiService } from "./ai_service.ts";
import type { RateLimitService } from "./src/services/rate_limit.ts";

// Discord API Base URL
const API_BASE = "https://discord.com/api/v10";

// In-memory cache of recent messages per channel
const messages_cache = new Map<string, Array<Record<string, unknown>>>();

// Cached bot user ID
let cached_bot_user_id: string | undefined;

/**
 * Dependencies required by bot action handlers.
 */
export interface BotDependencies {
  config: AppConfig;
  aiService: AiService;
  rateLimitService: RateLimitService;
}

/**
 * Fetch and cache the bot's user ID from Discord API.
 */
export async function getBotUserId(config: AppConfig): Promise<string | undefined> {
  if (cached_bot_user_id) return cached_bot_user_id;

  if (!config.discordToken) {
    console.error("Cannot fetch bot user id: DISCORD_TOKEN missing");
    return undefined;
  }

  try {
    const res = await fetch(`${API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bot ${config.discordToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("Failed to fetch bot user info:", res.status, res.statusText);
      return undefined;
    }

    const data = await res.json();
    cached_bot_user_id = data.id;
    return cached_bot_user_id;
  } catch (err) {
    console.error("Error fetching bot user id:", err);
    return undefined;
  }
}

/**
 * Posts a poll to the specified channel.
 */
export async function postPoll(config: AppConfig, channel_id: string): Promise<void> {
  const date_formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const poll_payload = {
    poll: {
      question: { text: `Mood (${date_formatter.format(new Date())})` },
      answers: [
        { poll_media: { text: "umazing" } },
        { poll_media: { text: "ok" } },
        { poll_media: { text: "glue" } },
      ],
      duration: 24,
      allow_multiselect: false,
    },
  };

  try {
    const response = await fetch(`${API_BASE}/channels/${channel_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(poll_payload),
    });

    if (response.ok) {
      console.log("Poll posted successfully!");
    } else {
      console.error(`Failed to post poll: ${response.status} ${response.statusText}`);
      const body = await response.text();
      console.error(body);
    }
  } catch (error) {
    console.error("Error posting poll:", error);
  }
}

/**
 * Send a message to a channel.
 */
export async function sendMessage(
  config: AppConfig,
  channel_id: string,
  content: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!channel_id) return { ok: false, error: "missing channelId" };

  try {
    const response = await fetch(`${API_BASE}/channels/${channel_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (response.ok) {
      console.log("Message posted successfully!");
      return { ok: true, text: content };
    } else {
      const body = await response.text();
      console.error(`Failed to post message: ${response.status} ${response.statusText}`);
      console.error(body);
      return { ok: false, error: `Discord post error ${response.status}: ${body}` };
    }
  } catch (error) {
    console.error("Error posting message:", error);
    return { ok: false, error: String(error) };
  }
}

/**
 * Returns true if the message mentions the bot.
 */
export function bMessageMentionsBot(
  message: Record<string, unknown>,
  bot_id: string,
): boolean {
  if (!message) return false;

  const mentions = message.mentions as unknown;
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (typeof mm.id === "string" && mm.id === bot_id) return true;
        if (typeof mm.username === "string" && mm.username === bot_id) return true;
      }
    }
  }

  // Fallback: check content for <@ID> or <@!ID>
  const content = message.content as unknown;
  if (typeof content === "string") {
    if (content.includes(`<@${bot_id}>`) || content.includes(`<@!${bot_id}>`)) {
      return true;
    }
  }

  return false;
}

/**
 * Formats minutes into a human-readable string.
 */
function szFormatMinutes(ms: number): string {
  const minutes = Math.ceil(ms / 60000);
  if (minutes === 1) return "1 minute";
  return `${minutes} minutes`;
}

/**
 * Handle an incoming message. If it mentions the bot, check rate limits
 * and generate an AI response.
 */
export async function handleMessage(
  message: Record<string, unknown>,
  deps: BotDependencies,
): Promise<void> {
  const { config, aiService, rateLimitService } = deps;

  // Get bot user ID
  const bot_id = await getBotUserId(config);
  if (!bot_id) return;
  if (!message) return;

  // Ignore messages from bots (including self) to avoid loops
  const author = message["author"] as Record<string, unknown> | undefined;
  if (author) {
    const author_id = author["id"] as string | undefined;
    const author_is_bot = author["bot"] as boolean | undefined;
    if (author_is_bot) return;
    if (author_id && author_id === bot_id) return;
  }

  const channel_id = (message["channel_id"] ?? message["channelId"] ?? config.channelId) as
    | string
    | undefined;
  if (!channel_id) {
    console.error("No channel id available on incoming message");
    return;
  }

  // Check if message mentions the bot
  if (!bMessageMentionsBot(message, bot_id)) {
    return;
  }

  const user_id = (author?.["id"] as string) ?? "unknown";
  console.log(`Bot mentioned by user ${user_id} in channel ${channel_id}`);

  // Check if AI is enabled
  if (!config.aiEnabled) {
    console.log("AI is disabled, ignoring mention");
    return;
  }

  // Check per-user rate limit
  const rate_limit_result = await rateLimitService.checkUserRateLimit(user_id);
  if (!rate_limit_result.allowed) {
    const reset_time = szFormatMinutes(rate_limit_result.resetInMs);
    await sendMessage(
      config,
      channel_id,
      `Whoa there, speedy!~ I need a little break. Try again in ${reset_time}~`,
    );
    console.log(`User ${user_id} rate limited, reset in ${reset_time}`);
    return;
  }

  // Check daily token budget
  const budget_result = await rateLimitService.checkDailyBudget();
  if (!budget_result.allowed) {
    await sendMessage(
      config,
      channel_id,
      "I've used up all my brain power for today!~ Let's chat tomorrow~",
    );
    console.log("Daily token budget exhausted");
    return;
  }

  // Record the request (do this before making the API call)
  await rateLimitService.recordUserRequest(user_id);

  // Save recent messages as context
  await saveContext(config, channel_id, 5, message);
  const ctx = getContext(channel_id) ?? [];

  // Generate AI reply
  const ai_result = await aiService.generateReply(ctx);

  if (!ai_result.ok) {
    console.error("AI generation failed:", ai_result.error);
    await sendMessage(
      config,
      channel_id,
      "Hmm, my brain's a bit fuzzy right now. Try again in a moment~",
    );
    return;
  }

  // Record token usage
  await rateLimitService.recordTokenUsage(ai_result.tokensUsed);

  // Send the AI reply
  const send_result = await sendMessage(config, channel_id, ai_result.text);
  if (!send_result.ok) {
    console.error("Failed to send AI reply:", send_result.error);
  }
}

/**
 * Fetch the most recent N messages from a channel and cache them.
 */
export async function saveContext(
  config: AppConfig,
  channel_id: string,
  limit = 5,
  trigger_message?: Record<string, unknown>,
): Promise<void> {
  if (!channel_id) return;

  try {
    const res = await fetch(`${API_BASE}/channels/${channel_id}/messages?limit=${limit}`, {
      headers: {
        Authorization: `Bot ${config.discordToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("Failed to fetch recent messages:", res.status, res.statusText);
      return;
    }

    let msgs = (await res.json()) as Array<Record<string, unknown>>;
    msgs = msgs.reverse();

    // Ensure the triggering message is included
    if (trigger_message) {
      const trig_id = trigger_message["id"] as string | undefined;
      if (trig_id) {
        msgs = msgs.filter((m) => (m.id as string | undefined) !== trig_id);
      }
      msgs.push(trigger_message);
    }

    // Keep only the most recent messages
    if (msgs.length > limit) {
      msgs = msgs.slice(msgs.length - limit);
    }

    const simplified = msgs.map((m) => ({
      id: m.id,
      author: (m.author as Record<string, unknown>)?.username ??
        (m.author as Record<string, unknown>)?.id,
      content: m.content,
      timestamp: m.timestamp ?? m.created_at ?? null,
    }));

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

// ============================================================================
// Legacy exports for backwards compatibility during migration
// ============================================================================

// Keep these for any code that still imports from the old API
export { bMessageMentionsBot as messageMentionsBot };
