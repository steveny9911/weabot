import type { CreatePollMessagePayload } from "./types.ts";
import type { EmbedMessagePayload } from "../features/stats.ts";
import { mapDiscordMessage, type RecentDiscordMessage } from "../features/chat_context.ts";
import type { ReactionContext } from "../features/reactions.ts";
import { readReactionContext } from "./reaction_context.ts";
import { fetchWithRetry } from "../net/retry.ts";
import { botJsonHeaders, DISCORD_API_BASE as API_BASE } from "./api.ts";

const REACTION_TIMEOUT_MS = 15_000;

export type MessagePayload =
  | CreatePollMessagePayload
  | EmbedMessagePayload
  | { content: string; allowed_mentions?: { parse: string[] } };

export interface PollVoter {
  userId: string;
  userName: string;
}

export interface PollAnswerVoters {
  answerId: number;
  answerText: string;
  voters: PollVoter[];
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** Haru's Discord REST calls. Reads retry; writes retry only a 429; reactions are sent once. */
export interface DiscordClient {
  /** The bot's own user ID, read once and then cached; undefined if Discord cannot say. */
  getBotUserId(): Promise<string | undefined>;

  postMessage(channelId: string, payload: MessagePayload): Promise<Response>;

  /** A text reply. `suppressMentions` sends it without pinging anyone. */
  sendMessage(channelId: string, content: string, suppressMentions?: boolean): Promise<SendResult>;

  /** Replies to a message with one image attached; `altText` is its description. */
  sendImage(
    channelId: string,
    image: {
      bytes: Uint8Array<ArrayBuffer>;
      filename: string;
      contentType: string;
      altText?: string;
      replyToMessageId: string;
    },
  ): Promise<SendResult>;

  /** Times a member out for `seconds`; needs Timeout Members. */
  timeoutMember(
    guildId: string,
    userId: string,
    seconds: number,
    reason: string,
  ): Promise<SendResult>;

  addReaction(channelId: string, messageId: string, emoji: string): Promise<Response>;

  /** Newest first; `limit` is clamped to 1-100. */
  getRecentMessages(channelId: string, limit: number): Promise<RecentDiscordMessage[]>;

  /** Optional for minimal injected clients; production always implements both live reads. */
  getReactionContext?(channelId: string, botUserId: string): Promise<ReactionContext>;
  getMessage?(channelId: string, messageId: string): Promise<RecentDiscordMessage | null>;

  /** Every voter of a finalized poll; throws if the poll is unfinished or incompletely read. */
  getPollVoters(channelId: string, messageId: string): Promise<PollAnswerVoters[]>;
}

export function createDiscordClient(token: string): DiscordClient {
  const headers = botJsonHeaders(token);
  let botUserId: string | undefined;

  const postMessage = (channelId: string, payload: MessagePayload) =>
    fetchWithRetry(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

  /** A write whose response body is not needed. Logs and returns the error; never throws. */
  async function write(label: string, send: () => Promise<Response>): Promise<SendResult> {
    let error: string;
    try {
      const response = await send();
      if (response.ok) {
        await response.body?.cancel();
        return { ok: true };
      }
      error = `Discord ${label} error ${response.status}: ${await response.text()}`;
    } catch (thrown) {
      error = String(thrown);
    }
    console.error(`[DISCORD] ${error}`);
    return { ok: false, error };
  }

  return {
    async getBotUserId() {
      if (botUserId) return botUserId;
      if (!token) {
        console.error("Cannot fetch bot user id: DISCORD_TOKEN missing");
        return undefined;
      }
      try {
        const response = await fetchWithRetry(`${API_BASE}/users/@me`, { headers });
        if (!response.ok) {
          await response.body?.cancel();
          console.error("Failed to fetch bot user info:", response.status);
          return undefined;
        }
        botUserId = ((await response.json()) as { id: string }).id;
        return botUserId;
      } catch (error) {
        console.error("Error fetching bot user id:", error);
        return undefined;
      }
    },

    postMessage,

    sendMessage: (channelId, content, suppressMentions = false) =>
      channelId
        ? write("post", () =>
            postMessage(channelId, {
              content,
              ...(suppressMentions ? { allowed_mentions: { parse: [] } } : {}),
            }),
          )
        : Promise.resolve({ ok: false, error: "missing channelId" }),

    sendImage: (channelId, { bytes, filename, contentType, altText, replyToMessageId }) =>
      write("upload", () => {
        const form = new FormData();
        form.append(
          "payload_json",
          JSON.stringify({
            // The reply pings the author, as a normal Discord reply does.
            message_reference: { message_id: replyToMessageId, fail_if_not_exists: false },
            attachments: [{ id: 0, filename, ...(altText ? { description: altText } : {}) }],
          }),
        );
        form.append("files[0]", new Blob([bytes], { type: contentType }), filename);
        // No Content-Type here: fetch adds the multipart one, with its boundary.
        return fetchWithRetry(
          `${API_BASE}/channels/${encodeURIComponent(channelId)}/messages`,
          { method: "POST", headers: { Authorization: headers.Authorization! }, body: form },
          { timeoutMs: 60_000 },
        );
      }),

    timeoutMember: (guildId, userId, seconds, reason) =>
      write("timeout", () =>
        fetchWithRetry(
          `${API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
          {
            method: "PATCH",
            headers: { ...headers, "X-Audit-Log-Reason": reason },
            body: JSON.stringify({
              communication_disabled_until: new Date(Date.now() + seconds * 1000).toISOString(),
            }),
          },
        ),
      ),

    async addReaction(channelId, messageId, emoji) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REACTION_TIMEOUT_MS);
      try {
        return await fetch(
          `${API_BASE}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
            messageId,
          )}/reactions/${encodeURIComponent(emoji)}/@me`,
          {
            method: "PUT",
            headers,
            signal: controller.signal,
            redirect: "error",
          },
        );
      } finally {
        clearTimeout(timer);
      }
    },

    async getRecentMessages(channelId, limit) {
      const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
      const response = await fetchWithRetry(
        `${API_BASE}/channels/${channelId}/messages?limit=${safeLimit}`,
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
        .filter(
          (message): message is Record<string, unknown> =>
            message !== null && typeof message === "object",
        )
        .map(mapDiscordMessage);
    },

    getReactionContext: (channelId, botId) => readReactionContext(token, channelId, botId),

    async getMessage(channelId, messageId) {
      // One deadline for every attempt together, including reading the body.
      const response = await fetchWithRetry(
        `${API_BASE}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
          messageId,
        )}`,
        { headers, signal: AbortSignal.timeout(REACTION_TIMEOUT_MS), redirect: "error" },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const data = (await response.json()) as Record<string, unknown> | null;
      return data && typeof data === "object" && data.id === messageId
        ? mapDiscordMessage(data)
        : null;
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
          typeof id !== "number" ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          answerIds.has(id) ||
          !media ||
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
          typeof count?.id !== "number" ||
          !answerIds.has(count.id) ||
          counts.has(count.id) ||
          typeof count.count !== "number" ||
          !Number.isSafeInteger(count.count) ||
          count.count < 0
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
              typeof user?.id !== "string" ||
              !/^[1-9]\d*$/.test(user.id) ||
              BigInt(user.id) <= after ||
              seen.has(user.id) ||
              (user.username != null && typeof user.username !== "string") ||
              (user.global_name != null && typeof user.global_name !== "string")
            ) {
              throw new Error(`[DISCORD] Invalid or repeated voter for ${answerContext}`);
            }
            seen.add(user.id);
            const id = BigInt(user.id);
            if (id > nextAfter) nextAfter = id;
            voters.push({
              userId: user.id,
              userName: (user.global_name ?? user.username ?? user.id) as string,
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
    ? (value as Record<string, unknown>)
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
