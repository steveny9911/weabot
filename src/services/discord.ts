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
import { oMapDiscordMessage, type RecentDiscordMessage } from "../features/chat_context/mod.ts";
import { fetchWithRetry } from "../utils/retry.ts";

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
   * Gets recent channel messages for context-aware scheduled jobs
   * @param channelId - The Discord channel ID
   * @param limit - Number of messages to fetch, clamped to Discord's 1-100 range
   * @returns Recent messages in Discord API order (newest first)
   */
  getRecentMessages(channelId: string, limit: number): Promise<RecentDiscordMessage[]>;

  /**
   * Gets every voter for every answer in a finalized poll
   * @param channelId - The channel containing the poll
   * @param messageId - The message ID of the poll
   * @returns Complete answers with their voters, including zero-vote answers
   * @throws If the poll is unfinished, malformed, inaccessible, or incompletely retrieved
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
        .map(oMapDiscordMessage);
    },

    async getPollVoters(channelId, messageId) {
      const context = `poll ${messageId} in channel ${channelId}`;
      const message = await getPollJson(
        `${API_BASE}/channels/${channelId}/messages/${messageId}`,
        headers,
        context,
      );
      const poll = asRecord(message.poll);
      if (!poll || !Array.isArray(poll.answers) || poll.answers.length === 0) {
        throw new Error(`[DISCORD] Invalid answers for ${context}`);
      }

      const answerIds = new Set<number>();
      const answers = poll.answers.map((value: unknown) => {
        const answer = asRecord(value);
        const id = answer?.answer_id;
        const media = asRecord(answer?.poll_media);
        if (
          typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
          answerIds.has(id) || !media ||
          (media.text != null && typeof media.text !== "string")
        ) {
          throw new Error(`[DISCORD] Invalid or duplicate answer for ${context}`);
        }
        answerIds.add(id);
        return { id, text: typeof media.text === "string" ? media.text : `Answer ${id}` };
      });

      // Finished polls always include results. Only the finalized tally is exact.
      // https://docs.discord.com/developers/resources/poll#poll-results-object
      const tally = asRecord(poll.results);
      if (tally?.is_finalized !== true || !Array.isArray(tally.answer_counts)) {
        throw new Error(`[DISCORD] Missing or unfinalized results for ${context}; retry later`);
      }
      const counts = new Map<number, number>();
      for (const value of tally.answer_counts) {
        const count = asRecord(value);
        if (
          typeof count?.id !== "number" || !answerIds.has(count.id) || counts.has(count.id) ||
          typeof count.count !== "number" || !Number.isSafeInteger(count.count) || count.count < 0
        ) {
          throw new Error(`[DISCORD] Invalid answer counts for ${context}`);
        }
        counts.set(count.id, count.count);
      }

      const results: PollAnswerVoters[] = [];
      for (const answer of answers) {
        const answerContext = `${context}, answer ${answer.id}`;
        // Absent answers in a finalized tally have zero votes, per Discord's API contract.
        const expectedCount = counts.get(answer.id) ?? 0;
        const voters: PollVoter[] = [];
        const seen = new Set<string>();
        let after = 0n;
        while (true) {
          const url = new URL(
            `${API_BASE}/channels/${channelId}/polls/${messageId}/answers/${answer.id}`,
          );
          url.searchParams.set("limit", "100");
          if (after > 0n) url.searchParams.set("after", after.toString());
          const data = await getPollJson(url.toString(), headers, answerContext);
          if (!Array.isArray(data.users) || data.users.length > 100) {
            throw new Error(`[DISCORD] Invalid voters for ${answerContext}`);
          }

          let nextAfter = after;
          for (const value of data.users) {
            const user = asRecord(value);
            if (
              typeof user?.id !== "string" || !/^[1-9]\d*$/.test(user.id) ||
              BigInt(user.id) <= after || seen.has(user.id) ||
              (user.username != null && typeof user.username !== "string") ||
              (user.global_name != null && typeof user.global_name !== "string")
            ) {
              throw new Error(`[DISCORD] Invalid or repeated voter for ${answerContext}`);
            }
            seen.add(user.id);
            const id = BigInt(user.id);
            if (id > nextAfter) nextAfter = id;
            voters.push({
              odUserId: user.id,
              odUserName: (user.global_name ?? user.username ?? user.id) as string,
            });
          }
          if (voters.length > expectedCount) {
            throw new Error(`[DISCORD] Voter count exceeds finalized tally for ${answerContext}`);
          }
          if (data.users.length < 100) break;
          after = nextAfter;
        }
        if (voters.length !== expectedCount) {
          throw new Error(
            `[DISCORD] Incomplete voters for ${answerContext}: expected ${expectedCount}, got ${voters.length}`,
          );
        }
        results.push({ answerId: answer.id, answerText: answer.text, voters });
      }
      return results;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function getPollJson(
  url: string,
  headers: Record<string, string>,
  context: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetchWithRetry(url, { headers });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const data = asRecord(await response.json());
    if (!data) throw new Error("Expected an object response");
    return data;
  } catch (error) {
    throw new Error(`[DISCORD] Failed to retrieve ${context}`, { cause: error });
  }
}
