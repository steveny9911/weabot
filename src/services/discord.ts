/**
 * Discord API Client Service
 *
 * Abstracts all Discord REST API calls behind an injectable interface.
 * This keeps HTTP details out of the business logic and enables
 * dependency injection for testing (pass a mock client instead).
 */

import type { CreatePollMessagePayload } from "../types/discord.ts";

const API_BASE = "https://discord.com/api/v10";

/** Discord API client interface for dependency injection */
export interface DiscordClient {
  /**
   * Posts a message with a poll to a channel
   * @param channelId - The Discord channel ID
   * @param payload - The message payload containing the poll
   * @returns The raw fetch Response for error handling
   */
  postMessage(channelId: string, payload: CreatePollMessagePayload): Promise<Response>;

  // Future methods can be added here:
  // getChannel(channelId: string): Promise<Channel>;
  // createSlashCommand(...): Promise<...>;
  // sendInteractionResponse(...): Promise<...>;
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
  };
}
