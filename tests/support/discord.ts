/** A fake `DiscordClient` for bot tests: it records sent text and serves raw messages as history. */
import type { DiscordClient } from "../../src/discord/client.ts";
import { mapDiscordMessage } from "../../src/features/chat_context.ts";

export function fakeDiscord(
  options: {
    /** Every text the bot sends is pushed here. */
    sent?: string[];
    /** Raw Discord messages returned as channel history. */
    recent?: Array<Record<string, unknown>>;
    /** False makes every send fail. */
    sendOk?: boolean;
  } = {},
): DiscordClient {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  return {
    getBotUserId: () => Promise.resolve("12345"),
    getRecentMessages: () => Promise.resolve((options.recent ?? []).map(mapDiscordMessage)),
    sendMessage(_channelId, content) {
      options.sent?.push(content);
      return Promise.resolve(options.sendOk === false ? { ok: false, error: "500" } : { ok: true });
    },
    postMessage: unexpected("postMessage"),
    timeoutMember: unexpected("timeoutMember"),
    addReaction: unexpected("addReaction"),
    getPollVoters: unexpected("getPollVoters"),
  };
}
