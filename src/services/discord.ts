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
   * Gets voters for all answers in a poll
   * @param channelId - The channel containing the poll
   * @param messageId - The message ID of the poll
   * @returns Array of answers with their voters
   */
  getPollVoters(channelId: string, messageId: string): Promise<PollAnswerVoters[]>;
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

    async getPollVoters(channelId, messageId) {
      // First, get the message to find poll answers
      const msgResponse = await fetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, {
        headers,
      });

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
        const votersResponse = await fetch(
          `${API_BASE}/channels/${channelId}/polls/${messageId}/answers/${answerId}`,
          { headers },
        );

        if (!votersResponse.ok) {
          console.error(`[DISCORD] Failed to get voters for answer ${answerId}: ${votersResponse.status}`);
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
