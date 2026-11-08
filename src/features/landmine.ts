/** Landmines: any message may be one, and its author is timed out for stepping on it. */
import type { AppConfig } from "../config.ts";
import { formatTime, isCommand } from "../bot/commands.ts";
import { sendMessage, timeoutMember } from "../discord/messages.ts";
import type { createLandmineQueries } from "../db/landmines.ts";

export interface LandmineService {
  /** Rolls one message; on a landmine times the author out and announces it. Never throws. */
  step(message: Record<string, unknown>): Promise<void>;
}

export interface LandmineDependencies {
  config: AppConfig;
  mines: ReturnType<typeof createLandmineQueries>;
  random?: () => number;
  timeout?: typeof timeoutMember;
  send?: typeof sendMessage;
}

export function createLandmineService(deps: LandmineDependencies): LandmineService {
  const { config, mines, random = Math.random, timeout = timeoutMember, send = sendMessage } = deps;

  return {
    async step(message) {
      const guildId = message["guild_id"];
      const channelId = message["channel_id"];
      const userId = (message["author"] as { id?: unknown } | undefined)?.id;
      // Only what a person typed: a normal message (0) or a reply (19), not joins, pins, boosts...
      const type = message["type"] ?? 0;
      if (!config.landmineEnabled) return;
      if (type !== 0 && type !== 19) return;
      if (typeof guildId !== "string" || typeof channelId !== "string") return;
      if (typeof userId !== "string") return;
      if (!config.landmineChannelIds.includes(channelId)) return;
      if (isCommand(message["content"] as string | undefined)) return;
      if (random() >= config.landmineChance) return;

      try {
        const remaining = mines.claim();
        if (remaining === null) return;

        const seconds = config.landmineTimeoutSeconds;
        const result = await timeout(config, guildId, userId, seconds, "Stepped on a landmine");
        if (!result.ok) {
          mines.refund();
          console.error(`[LANDMINE] Could not time out ${userId}: ${result.error}`);
          return;
        }

        const duration = formatTime(seconds * 1000);
        console.log(`[LANDMINE] ${userId} stepped on one in ${channelId}; ${remaining} left`);
        await send(
          config,
          channelId,
          `💥<@${userId}>💥 stepped on a landmine and has been timed out for ${duration}! ` +
            `(${remaining.toLocaleString("en-US")} landmines remaining)`,
        );
      } catch (error) {
        console.error("[LANDMINE] Failed:", error);
      }
    },
  };
}
