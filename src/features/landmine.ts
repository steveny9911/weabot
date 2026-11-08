/** Landmines: any message may be one. Haru announces who stepped on it and can time them out. */
import type { AppConfig } from "../config.ts";
import { formatTime, isCommand } from "../bot/commands.ts";
import { sendMessage, timeoutMember } from "../discord/messages.ts";
import type { createLandmineQueries } from "../db/landmines.ts";

export interface LandmineService {
  /** Rolls one message; on a landmine announces it, and times the author out if enabled. Never throws. */
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

        let timedOut = "";
        if (config.landmineTimeoutEnabled) {
          const seconds = config.landmineTimeoutSeconds;
          const result = await timeout(config, guildId, userId, seconds, "Stepped on a landmine");
          if (!result.ok) {
            mines.refund();
            console.error(`[LANDMINE] Could not time out ${userId}: ${result.error}`);
            return;
          }
          timedOut = ` and has been timed out for ${formatTime(seconds * 1000)}`;
        }

        const gif = config.landmineGifs[Math.floor(random() * config.landmineGifs.length)];
        console.log(`[LANDMINE] ${userId} stepped on one in ${channelId}; ${remaining} left`);
        await send(
          config,
          channelId,
          `💥<@${userId}>💥 stepped on a landmine${timedOut}! ` +
            `(${remaining.toLocaleString("en-US")} landmines remaining)` +
            (gif ? `\n${gif}` : ""),
        );
      } catch (error) {
        console.error("[LANDMINE] Failed:", error);
      }
    },
  };
}
