/** Interactive local Haru, restricted to Bot Sandbox #general and a local-only trigger. */
import { type AiService, createAiService } from "../ai_service.ts";
import { bMessageMentionsBot, getBotUserId, handleMessage } from "../bot_actions.ts";
import { startGateway } from "../discord_gateway.ts";
import { loadConfig } from "../src/config.ts";
import { createDiscordActionService } from "../src/features/discord_actions/mod.ts";
import { createDiscordEventsClient } from "../src/services/discord_events.ts";
import { createLinkOpenService } from "../src/services/link_open.ts";
import { createRateLimitService } from "../src/services/rate_limit.ts";
import { createStorageService } from "../src/services/storage.ts";

export const SANDBOX_ID = "589723496473690132";
export const TEXT_CHANNEL_ID = "589723496473690134";

/** Adapt only the local trigger; preserve Discord's actual requester and message identity. */
export function localSandboxMessage(
  message: Record<string, unknown>,
  botId: string,
): Record<string, unknown> | null {
  const author = message.author as Record<string, unknown> | undefined;
  if (
    message.guild_id !== SANDBOX_ID || message.channel_id !== TEXT_CHANNEL_ID ||
    typeof message.id !== "string" || !message.id || !author ||
    typeof author.id !== "string" || !author.id || author.id === botId ||
    author.bot || message.webhook_id || typeof message.content !== "string" ||
    !/^Haru local,\s*\S/i.test(message.content) || bMessageMentionsBot(message, botId)
  ) return null;

  // A real @Haru mention would wake the deployed bot too. Recognize the local
  // prefix only inside this process, without editing the posted message.
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  return { ...message, mentions: [...mentions, { id: botId }] };
}

async function main(): Promise<void> {
  const config = {
    ...loadConfig(),
    channelId: TEXT_CHANNEL_ID,
    channelIds: [TEXT_CHANNEL_ID],
    timeZone: "America/Vancouver",
    aiEnabled: true,
    aiEnableUwu: false,
    // Minimize fetched history. The AI wrapper below excludes it altogether.
    aiContextMaxMessages: 1,
    webSearchEnabled: false,
    linkOpenEnabled: false,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: [],
    discordActionsEnabled: true,
    discordActionsGuildIds: [SANDBOX_ID],
  };
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required.");
  const events = createDiscordEventsClient(config.discordToken);
  const guild = await events.getGuild(SANDBOX_ID);
  if (guild.id !== SANDBOX_ID || (guild as unknown as { name: string }).name !== "Bot Sandbox") {
    throw new Error("Expected Bot Sandbox.");
  }
  const botId = await getBotUserId(config);
  if (!botId) throw new Error("Could not verify the configured bot identity.");
  const channels = await events.getChannels(SANDBOX_ID);
  if (!channels.some((c) => c.id === TEXT_CHANNEL_ID && c.type === 0 && c.name === "general")) {
    throw new Error("Expected Bot Sandbox #general.");
  }
  const kv = await Deno.openKv(":memory:");
  const realAi = createAiService(config);
  const localAi: AiService = {
    ...realAi,
    generateReply(_messages, options) {
      if (!options?.currentUserMessage) throw new Error("Expected a local action session.");
      // The action session includes the real current request and any pending
      // clarification. Never forward unrelated fetched chat history or images.
      return realAi.generateReply([], {
        ...options,
        async executeTool(name, args) {
          const result = await options.executeTool(name, args);
          console.log(
            "[LOCAL TOOL]",
            JSON.stringify({
              name,
              ok: result.ok,
              eventId: result.eventId,
              inviteUrl: result.inviteUrl,
              uncertain: result.uncertain,
              needsClarification: result.needsClarification,
              cancelled: result.cancelled,
              ...(name === "create_discord_invite"
                ? { inviteMaxAge: args.max_age, inviteMaxUses: args.max_uses }
                : {}),
            }),
          );
          return result;
        },
      });
    },
  };
  const deps = {
    config,
    aiService: localAi,
    rateLimitService: createRateLimitService(kv, config),
    linkOpenService: createLinkOpenService(config),
    storageService: createStorageService(kv),
    discordActionService: createDiscordActionService(events, kv, config.timeZone),
  };

  console.log(`[LOCAL] Bot Sandbox #general only. Bot identity: ${botId}`);
  console.log('[LOCAL] Send "Haru local, create ..." without an @Haru mention.');
  console.log(
    "[LOCAL] In-memory state; no cron jobs, HTTP server, or autonomous chat. Ctrl-C to stop.",
  );
  startGateway(config, deps, async (message, dependencies) => {
    const localMessage = localSandboxMessage(message, botId);
    if (!localMessage) return;
    console.log(`[LOCAL] Handling Discord message ${message.id}`);
    await handleMessage(localMessage, dependencies);
    console.log(`[LOCAL] Finished Discord message ${message.id}`);
  });
}

if (import.meta.main) await main();
