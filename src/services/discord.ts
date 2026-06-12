/**
 * Discord API Client Service
 *
 * Abstracts all Discord REST API calls behind an injectable interface.
 * This keeps HTTP details out of the business logic and enables
 * dependency injection for testing (pass a mock client instead).
 *
 * Includes automatic retry with exponential backoff for reliability.
 */

import type { CreatePollMessagePayload } from "../types/discord.ts";
import type { EmbedMessagePayload } from "../features/stats/mod.ts";
import type { RecentDiscordMessage } from "../features/autonomous_chat/mod.ts";
import { fetchWithRetry } from "../utils/retry.ts";

const API_BASE = "https://discord.com/api/v10";
const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?)$/i;

/** Generic message payload (polls, embeds, text, etc.) */
export type MessagePayload =
  | CreatePollMessagePayload
  | EmbedMessagePayload
  | { content: string };

/** A voter from a poll answer */
export interface PollVoter {
  odUserId: string;
  odUserName: string;
}

/** Poll answer with voters */
export interface PollAnswerVoters {
  answerId: number;
  answerText: string;
  voters: PollVoter[];
}

/** Discord API client interface for dependency injection */
export interface DiscordClient {
  /**
   * Posts a message to a channel (poll, embed, or text)
   * @param channelId - The Discord channel ID
   * @param payload - The message payload
   * @returns The raw fetch Response for error handling
   */
  postMessage(channelId: string, payload: MessagePayload): Promise<Response>;

  /**
   * Sends a direct message to a user
   * @param userId - The Discord user ID
   * @param payload - The message payload
   * @returns The raw fetch Response for error handling
   */
  sendDM(userId: string, payload: MessagePayload): Promise<Response>;

  /**
   * Gets recent channel messages for context-aware scheduled jobs
   * @param channelId - The Discord channel ID
   * @param limit - Number of messages to fetch, clamped to Discord's 1-100 range
   * @returns Recent messages in Discord API order (newest first)
   */
  getRecentMessages(channelId: string, limit: number): Promise<RecentDiscordMessage[]>;

  /**
   * Gets voters for all answers in a poll
   * @param channelId - The channel containing the poll
   * @param messageId - The message ID of the poll
   * @returns Array of answers with their voters
   */
  getPollVoters(channelId: string, messageId: string): Promise<PollAnswerVoters[]>;
}

function bIsHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function bAttachmentLooksLikeImage(attachment: Record<string, unknown>): boolean {
  const content_type = attachment["content_type"];
  if (typeof content_type === "string" && content_type.startsWith("image/")) {
    return true;
  }

  const filename = attachment["filename"];
  if (typeof filename === "string" && IMAGE_FILE_EXT_RE.test(filename)) {
    return true;
  }

  const width = attachment["width"];
  const height = attachment["height"];
  return typeof width === "number" && width > 0 && typeof height === "number" && height > 0;
}

function aszExtractImageUrlsFromDiscordMessage(message: Record<string, unknown>): string[] {
  const attachments = message["attachments"];
  if (!Array.isArray(attachments)) return [];

  const image_urls: string[] = [];
  for (const raw_attachment of attachments) {
    if (!raw_attachment || typeof raw_attachment !== "object") continue;

    const attachment = raw_attachment as Record<string, unknown>;
    if (!bAttachmentLooksLikeImage(attachment)) continue;

    const candidate = typeof attachment["url"] === "string"
      ? attachment["url"]
      : (typeof attachment["proxy_url"] === "string" ? attachment["proxy_url"] : undefined);
    if (!candidate) continue;

    const trimmed = candidate.trim();
    if (!trimmed || !bIsHttpUrl(trimmed)) continue;
    image_urls.push(trimmed);
  }

  return [...new Set(image_urls)];
}

function szDiscordAuthorName(author: Record<string, unknown>): string {
  const global_name = author["global_name"];
  if (typeof global_name === "string" && global_name.trim()) return global_name;

  const username = author["username"];
  if (typeof username === "string" && username.trim()) return username;

  const id = author["id"];
  return typeof id === "string" && id.trim() ? id : "unknown";
}

function oMapRecentMessage(message: Record<string, unknown>): RecentDiscordMessage {
  const author = message["author"] && typeof message["author"] === "object"
    ? message["author"] as Record<string, unknown>
    : {};

  const id = message["id"];
  const author_id = author["id"];
  const content = message["content"];
  const timestamp = message["timestamp"];

  return {
    id: typeof id === "string" ? id : "",
    authorId: typeof author_id === "string" ? author_id : "",
    authorName: szDiscordAuthorName(author),
    authorBot: author["bot"] === true,
    content: typeof content === "string" ? content : "",
    timestamp: typeof timestamp === "string" ? timestamp : "",
    imageUrls: aszExtractImageUrlsFromDiscordMessage(message),
  };
}

/**
 * Creates a Discord API client with the given bot token.
 * @param token - The Discord bot token
 * @returns A DiscordClient implementation
 */
export function createDiscordClient(token: string): DiscordClient {
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  return {
    async postMessage(channelId, payload) {
      const response = await fetchWithRetry(
        `${API_BASE}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        },
      );
      return response;
    },

    async sendDM(userId, payload) {
      // First, create a DM channel with the user
      const dmChannelResponse = await fetchWithRetry(`${API_BASE}/users/@me/channels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ recipient_id: userId }),
      });

      if (!dmChannelResponse.ok) {
        return dmChannelResponse;
      }

      const dmChannel = await dmChannelResponse.json();
      const channelId = dmChannel.id;

      // Then send the message to that channel
      return await fetchWithRetry(`${API_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },

    async getRecentMessages(channelId, limit) {
      const safe_limit = Math.min(100, Math.max(1, Math.trunc(limit)));
      const response = await fetchWithRetry(
        `${API_BASE}/channels/${channelId}/messages?limit=${safe_limit}`,
        { headers },
      );

      if (!response.ok) {
        console.error(`[DISCORD] Failed to get recent messages: ${response.status}`);
        return [];
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        console.error("[DISCORD] Recent messages response was not an array");
        return [];
      }

      return data
        .filter((message): message is Record<string, unknown> =>
          message !== null && typeof message === "object"
        )
        .map(oMapRecentMessage);
    },

    async getPollVoters(channelId, messageId) {
      // First, get the message to find poll answers
      const msgResponse = await fetchWithRetry(
        `${API_BASE}/channels/${channelId}/messages/${messageId}`,
        { headers },
      );

      if (!msgResponse.ok) {
        console.error(`[DISCORD] Failed to get poll message: ${msgResponse.status}`);
        return [];
      }

      const message = await msgResponse.json();
      const poll = message.poll;

      if (!poll || !poll.answers) {
        console.error("[DISCORD] Message is not a poll or has no answers");
        return [];
      }

      const results: PollAnswerVoters[] = [];

      // Fetch voters for each answer
      for (const answer of poll.answers) {
        const answerId = answer.answer_id;
        const answerText = answer.poll_media?.text ?? `Answer ${answerId}`;

        // Discord API: GET /channels/{channel.id}/polls/{message.id}/answers/{answer.id}
        const votersResponse = await fetchWithRetry(
          `${API_BASE}/channels/${channelId}/polls/${messageId}/answers/${answerId}`,
          { headers },
        );

        if (!votersResponse.ok) {
          console.error(
            `[DISCORD] Failed to get voters for answer ${answerId}: ${votersResponse.status}`,
          );
          continue;
        }

        const votersData = await votersResponse.json();
        const voters: PollVoter[] = (votersData.users ?? []).map(
          (user: { id: string; username?: string; global_name?: string }) => ({
            odUserId: user.id,
            odUserName: user.global_name ?? user.username ?? user.id,
          }),
        );

        results.push({
          answerId,
          answerText,
          voters,
        });
      }

      return results;
    },
  };
}
