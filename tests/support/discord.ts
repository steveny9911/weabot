/** A fake `DiscordClient` for bot tests: it records sent text and serves raw messages as history. */
import type { DiscordClient, MessagePayload } from "../../src/discord/client.ts";
import { mapDiscordMessage } from "../../src/features/chat_context.ts";

export function fakeDiscord(
  options: {
    /** Every text the bot sends is pushed here. */
    sent?: string[];
    /** Raw Discord messages returned as channel history. */
    recent?: Array<Record<string, unknown>>;
    /** Every image the bot sends is pushed here. */
    images?: Array<{ channelId: string; filename: string; altText?: string; replyTo: string }>;
    /** Counts each typing indicator the bot sends. */
    typing?: { count: number };
    /** The message each text reply is threaded under, in send order. */
    replyTos?: Array<string | undefined>;
    /** Every embed or poll the bot posts is pushed here. */
    posts?: Array<{ channelId: string; payload: MessagePayload }>;
    /** False makes every send fail. */
    sendOk?: boolean;
    /** The id every text send reports; none if unset, as when Discord does not say. */
    messageId?: string;
    /** Every edit the bot makes is pushed here. */
    edits?: Array<{ messageId: string; content: string }>;
    /** False makes every edit fail. */
    editOk?: boolean;
  } = {},
): DiscordClient {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  return {
    getBotUserId: () => Promise.resolve("12345"),
    getRecentMessages: () => Promise.resolve((options.recent ?? []).map(mapDiscordMessage)),
    sendMessage(_channelId, content, sendOptions) {
      options.sent?.push(content);
      options.replyTos?.push(sendOptions?.replyTo);
      return Promise.resolve(
        options.sendOk === false
          ? { ok: false, error: "500" }
          : { ok: true, ...(options.messageId ? { id: options.messageId } : {}) },
      );
    },
    editMessage(_channelId, messageId, content) {
      options.edits?.push({ messageId, content });
      return Promise.resolve(options.editOk === false ? { ok: false, error: "500" } : { ok: true });
    },
    sendTyping() {
      if (options.typing) options.typing.count += 1;
      return Promise.resolve();
    },
    sendImage(channelId, image) {
      const { filename, altText, replyToMessageId: replyTo } = image;
      options.images?.push({ channelId, filename, altText, replyTo });
      return Promise.resolve(options.sendOk === false ? { ok: false, error: "500" } : { ok: true });
    },
    postMessage(channelId, payload) {
      if (!options.posts) return unexpected("postMessage")();
      options.posts.push({ channelId, payload });
      return Promise.resolve(new Response("{}", { status: options.sendOk === false ? 500 : 200 }));
    },
    timeoutMember: unexpected("timeoutMember"),
    addReaction: unexpected("addReaction"),
    getPollVoters: unexpected("getPollVoters"),
  };
}
