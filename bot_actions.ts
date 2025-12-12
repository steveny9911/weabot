// Bot actions: posting messages and polls, and handling incoming messages
import { generateReplyFromMessages } from "./ai_service.ts";

// Environment variables
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const CHANNEL_ID = Deno.env.get("CHANNEL_ID");

// Discord API Base URL
const API_BASE = "https://discord.com/api/v10";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};
if (DISCORD_TOKEN) HEADERS.Authorization = `Bot ${DISCORD_TOKEN}`;

// In-memory cache of recent messages per channel
const messagesCache = new Map<string, Array<Record<string, unknown>>>();

let BOT_USER_ID: string | undefined;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

// Helper: fetch and cache the bot's user id from Discord API.
export async function getBotUserId(): Promise<string | undefined> {
  if (BOT_USER_ID) return BOT_USER_ID;
  if (!DISCORD_TOKEN) {
    console.error("Cannot fetch bot user id: DISCORD_TOKEN missing");
    return undefined;
  }
  try {
    const res = await fetch(`${API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      console.error("Failed to fetch bot user info:", res.status, res.statusText);
      return undefined;
    }
    const data = await res.json();
    BOT_USER_ID = data.id;
    return BOT_USER_ID;
  } catch (err) {
    console.error("Error fetching bot user id:", err);
    return undefined;
  }
}

/**
 * Posts the poll to the specified channel.
 */
export async function postPoll(channelId: string) {
  const pollPayload = {
    poll: {
      question: { text: `Mood (${dateFormatter.format(new Date())})` },
      answers: [
        { poll_media: { text: "umazing" } },
        { poll_media: { text: "ok" } },
        { poll_media: { text: "glue" } },
      ],
      duration: 24, // Duration in hours
      allow_multiselect: false,
    },
  };

  try {
    const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(pollPayload),
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
 * Send a message to the specified channel. If we have cached context for the channel,
 * repeat back the recent messages as the message content; otherwise send a default test message.
 */
/**
 * Send an arbitrary message to the specified channel. Returns the sent text on success.
 */
export async function sendMessage(channelId: string, content: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!channelId) return { ok: false, error: "missing channelId" };
  const messagePayload = { content };
  try {
    const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(messagePayload),
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
 * Returns true if the provided message object mentions this bot.
 * Accepts a Discord message payload shape (gateway/message create).
 */
export function messageMentionsBot(message: Record<string, unknown>, botId: string): boolean {
  if (!message) return false;

  const mentions = message.mentions as unknown;
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (typeof mm.id === "string" && mm.id === botId) return true;
        if (typeof mm.username === "string" && mm.username === botId) return true;
      }
    }
  }
  // fallback: check content for <@ID> or <@!ID>
  const content = message.content as unknown;
  if (typeof content === "string") {
    if (content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`)) {
      return true;
    }
  }
  return false;
}

/**
 * Handle an incoming message object; if it mentions the bot, send the test message to the same channel.
 */
export async function handleMessage(message: Record<string, unknown>) {
  const botId = await getBotUserId();
  if (!botId) return;
  if (!message) return;
  // Ignore messages from the bot itself or other bots to avoid loops
  const author = message["author"] as Record<string, unknown> | undefined;
  if (author) {
    const authorId = author["id"] as string | undefined;
    const authorIsBot = author["bot"] as boolean | undefined;
    if (authorIsBot) return; // ignore any bot messages
    if (authorId && authorId === botId) return; // ignore self
  }
  const channelId = (message["channel_id"] ?? message["channelId"] ?? CHANNEL_ID) as string | undefined;
  if (!channelId) {
    console.error("No channel id available on incoming message");
    return;
  }
  if (messageMentionsBot(message, botId)) {
    console.log("Bot was mentioned in channel", channelId, "— saving context and generating reply");
  // save recent messages as context for this channel, include the triggering message
  await saveContext(channelId, 5, message);
    // get cached context
    const ctx = getContext(channelId) ?? [];
    // generate reply from AI service
    const aiRes = await generateReplyFromMessages(ctx);
    if (!aiRes.ok) {
      console.error("AI generation failed:", aiRes.error);
      // fallback: send a simple acknowledgment
      await sendMessage(channelId, "Sorry, I couldn't generate a reply right now.");
      return;
    }
    // send the AI reply
    const sendRes = await sendMessage(channelId, aiRes.text);
    if (!sendRes.ok) {
      console.error("Failed to send AI reply:", sendRes.error);
    }
  }
}

/**
 * Fetch the most recent N messages from a channel and cache them as context.
 */
export async function saveContext(
  channelId: string,
  limit = 5,
  triggerMessage?: Record<string, unknown>,
): Promise<void> {
  if (!channelId) return;
  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/messages?limit=${limit}`, {
      headers: HEADERS,
    });
    if (!res.ok) {
      console.error("Failed to fetch recent messages:", res.status, res.statusText);
      return;
    }
    let msgs = await res.json() as Array<Record<string, unknown>>;
    msgs = msgs.reverse();

    // Ensure the triggering message is included as the newest message in the context
    if (triggerMessage) {
      try {
        const trigId = triggerMessage["id"] as string | undefined;
        if (trigId) {
          msgs = msgs.filter((m) => (m.id as string | undefined) !== trigId);
          msgs.push(triggerMessage);
        } else {
          msgs.push(triggerMessage);
        }
      } catch (_e) {
        msgs.push(triggerMessage);
      }
    }

    // Keep only the most recent `limit` messages (msgs is chronological oldest->newest)
    if (msgs.length > limit) msgs = msgs.slice(msgs.length - limit);

    const simplified = msgs.map((m) => ({
      id: m.id,
      author: (m.author as Record<string, unknown>)?.username ?? (m.author as Record<string, unknown>)?.id,
      content: m.content,
      timestamp: m.timestamp ?? m.created_at ?? null,
    }));
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
