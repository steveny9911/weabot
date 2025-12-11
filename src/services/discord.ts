/**
 * Discord API Client Service
 *
 * Abstracts all Discord REST API calls behind an injectable interface.
 * This keeps HTTP details out of the business logic and enables
 * dependency injection for testing (pass a mock client instead).
 */

import type { CreatePollMessagePayload } from "../types/discord.ts";
import type { EmbedMessagePayload } from "../features/stats/mod.ts";

const API_BASE = "https://discord.com/api/v10";

/** Generic message payload (polls, embeds, text, etc.) */
export type MessagePayload =
  | CreatePollMessagePayload
  | EmbedMessagePayload
  | { content: string };

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
      const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      return response;
    },

    async sendDM(userId, payload) {
      // First, create a DM channel with the user
      const dmChannelResponse = await fetch(`${API_BASE}/users/@me/channels`, {
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
      return await fetch(`${API_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },
  };
}
