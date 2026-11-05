/** One explicit reaction consideration; never starts production jobs or fabricates human messages. */
import { createAiService } from "../ai_service.ts";
import { loadConfig } from "../src/config.ts";
import { participateInChannel } from "../src/features/autonomous_chat/participate.ts";
import { createDiscordClient, type DiscordClient } from "../src/services/discord.ts";
import { createDiscordEventsClient } from "../src/services/discord_events.ts";
import { createRateLimitService } from "../src/services/rate_limit.ts";
import { createStorageService } from "../src/services/storage.ts";

export const REACTION_SANDBOX_GUILD = "589723496473690132";
export const REACTION_SANDBOX_CHANNEL = "1144776120223408250";
export function sandboxOptions(args: string[]): { send: boolean; after: string } {
  const after = args.find((arg) => arg.startsWith("--after="))?.slice(8);
  if (
    args.some((arg) => arg !== "--send" && arg !== "--dry-run" && !arg.startsWith("--after=")) ||
    args.filter((arg) => arg.startsWith("--after=")).length !== 1 || !after ||
    !/^[1-9]\d*$/.test(after) ||
    args.includes("--send") && args.includes("--dry-run")
  ) throw new Error("Use [--send | --dry-run] --after=<message ID>.");
  return { send: args.includes("--send"), after };
}
export function sandboxDiscord(client: DiscordClient, after: string): DiscordClient {
  function check(channelId: string) {
    if (channelId !== REACTION_SANDBOX_CHANNEL) {
      throw new Error("Only Bot Sandbox #bitconnect-memes is allowed.");
    }
  }
  return {
    ...client,
    getRecentMessages: async (channelId, limit) => {
      check(channelId);
      return (await client.getRecentMessages(channelId, limit)).filter((m) =>
        /^\d+$/.test(m.id) && BigInt(m.id) > BigInt(after)
      );
    },
    postMessage: (channelId, payload) => {
      check(channelId);
      return client.postMessage(channelId, payload);
    },
    addReaction: (channelId, messageId, emoji) => {
      check(channelId);
      if (!/^\d+$/.test(messageId) || BigInt(messageId) <= BigInt(after)) {
        throw new Error("Target predates the test boundary.");
      }
      return client.addReaction(channelId, messageId, emoji);
    },
    sendDM: () => Promise.reject(new Error("Sandbox test cannot send DMs.")),
  };
}
async function main() {
  if (Deno.args.includes("--help")) {
    console.log(
      "One Bot Sandbox #bitconnect-memes consideration: [--send | --dry-run] --after=<boundary message ID>. Default is dry-run. Post real human test messages after the boundary; no @Haru mention. No production gateway, scheduler, config or state.",
    );
    return;
  }
  const options = sandboxOptions(Deno.args);
  const config = {
    ...loadConfig(),
    aiEnabled: true,
    autonomousChatEnabled: true,
    autonomousChatChannelIds: [REACTION_SANDBOX_CHANNEL],
    autonomousChatMinHumanMessages: 1,
    autonomousChatReplyChance: 1,
    autonomousChatSettleSeconds: 8,
  };
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required.");
  const real = createDiscordClient(config.discordToken);
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: "Bot " + config.discordToken },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("Could not verify bot identity.");
  const bot = await r.json();
  if (typeof bot.id !== "string") throw new Error("Invalid bot identity.");
  const context = await real.getReactionContext!(REACTION_SANDBOX_CHANNEL, bot.id);
  const events = createDiscordEventsClient(config.discordToken);
  const channels = await events.getChannels(REACTION_SANDBOX_GUILD);
  if (
    context.guildId !== REACTION_SANDBOX_GUILD ||
    !channels.some((c) =>
      c.id === REACTION_SANDBOX_CHANNEL && c.name === "bitconnect-memes" && c.type === 0
    )
  ) throw new Error("Sandbox identity mismatch.");
  // Live runs persist duplicate protection across invocations; previews use disposable memory.
  const kv = await Deno.openKv(options.send ? "/tmp/haru-reaction-sandbox.sqlite3" : ":memory:");
  try {
    console.log(
      "[SANDBOX]",
      JSON.stringify({
        guildId: context.guildId,
        channelId: REACTION_SANDBOX_CHANNEL,
        after: options.after,
        dryRun: !options.send,
        minHumanMessages: 1,
        replyChance: 1,
      }),
    );
    const outcome = await participateInChannel(REACTION_SANDBOX_CHANNEL, {
      config,
      discord: sandboxDiscord(real, options.after),
      storage: createStorageService(kv),
      ai: createAiService(config),
      rateLimit: createRateLimitService(kv, config),
      botId: bot.id,
      deliver: options.send,
    });
    console.log(JSON.stringify({ dryRun: !options.send, outcome }));
  } finally {
    kv.close();
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error("Sandbox reaction test failed; no additional actions attempted.");
    Deno.exitCode = 1;
  }
}
