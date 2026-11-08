/**
 * The bot's own Discord REST calls for chat: its user ID, plain text replies and recent channel
 * history. These calls make one attempt each, without retry, so a reply is never posted twice.
 */
import type { AppConfig } from "../config.ts";
import { botJsonHeaders, DISCORD_API_BASE } from "./api.ts";

let cachedBotUserId: string | undefined;

/** For tests: Bun runs every test file in one process, so the cache would leak between files. */
export function clearBotUserIdCache(): void {
  cachedBotUserId = undefined;
}

export async function getBotUserId(config: AppConfig): Promise<string | undefined> {
  if (cachedBotUserId) return cachedBotUserId;

  if (!config.discordToken) {
    console.error("Cannot fetch bot user id: DISCORD_TOKEN missing");
    return undefined;
  }

  try {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: botJsonHeaders(config.discordToken),
    });

    if (!res.ok) {
      console.error("Failed to fetch bot user info:", res.status, res.statusText);
      return undefined;
    }

    const data = (await res.json()) as { id: string };
    cachedBotUserId = data.id;
    return cachedBotUserId;
  } catch (err) {
    console.error("Error fetching bot user id:", err);
    return undefined;
  }
}

export async function sendMessage(
  config: AppConfig,
  channelId: string,
  content: string,
  suppressMentions = false,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!channelId) return { ok: false, error: "missing channelId" };

  try {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: botJsonHeaders(config.discordToken),
      body: JSON.stringify({
        content,
        ...(suppressMentions ? { allowed_mentions: { parse: [] } } : {}),
      }),
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

/** Newest first. Returns null on a Discord error; network errors propagate. */
export async function fetchChannelMessages(
  config: AppConfig,
  channelId: string,
  limit: number,
): Promise<Array<Record<string, unknown>> | null> {
  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`, {
    headers: botJsonHeaders(config.discordToken),
  });

  if (!res.ok) {
    console.error("Failed to fetch recent messages:", res.status, res.statusText);
    return null;
  }

  const data = await res.json();
  return Array.isArray(data)
    ? data.filter(
        (message): message is Record<string, unknown> =>
          message !== null && typeof message === "object",
      )
    : [];
}

/** Times a member out (needs Timeout Members). One attempt, no retry. */
export async function timeoutMember(
  config: AppConfig,
  guildId: string,
  userId: string,
  seconds: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: { ...botJsonHeaders(config.discordToken), "X-Audit-Log-Reason": reason },
        body: JSON.stringify({
          communication_disabled_until: new Date(Date.now() + seconds * 1000).toISOString(),
        }),
      },
    );
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    return {
      ok: false,
      error: `Discord timeout error ${response.status}: ${await response.text()}`,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
