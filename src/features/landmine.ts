/** Landmines: any message may be one. Haru announces who stepped on it and can time them out. */
import type { AppConfig } from "../config.ts";
import { formatTime, isCommand } from "../bot/commands.ts";
import { isActiveIn } from "../feature_config.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { createLandmineQueries } from "../db/landmines.ts";

export interface LandmineService {
  /** Rolls one message; on a landmine announces it, and times the author out if enabled. Never throws. */
  step(message: Record<string, unknown>): Promise<void>;
}

export interface LandmineDependencies {
  config: AppConfig;
  mines: ReturnType<typeof createLandmineQueries>;
  discord: Pick<DiscordClient, "sendMessage" | "timeoutMember">;
  random?: () => number;
}

export function createLandmineService(deps: LandmineDependencies): LandmineService {
  const { config, mines, discord, random = Math.random } = deps;

  return {
    async step(message) {
      const guildId = message["guild_id"];
      const channelId = message["channel_id"];
      const userId = (message["author"] as { id?: unknown } | undefined)?.id;
      // Only what a person typed: a normal message (0) or a reply (19), not joins, pins, boosts...
      const type = message["type"] ?? 0;
      if (type !== 0 && type !== 19) return;
      if (typeof guildId !== "string" || typeof channelId !== "string") return;
      if (typeof userId !== "string") return;
      if (!isActiveIn(config.landmine, channelId)) return;
      if (isCommand(message["content"] as string | undefined)) return;
      const roll = random();
      if (roll >= config.landmine.chance) {
        console.log(`[LANDMINE] Safe: ${userId} in ${channelId} (rolled ${roll.toFixed(3)})`);
        return;
      }

      try {
        const remaining = mines.claim();
        if (remaining === null) {
          console.log(`[LANDMINE] ${userId} rolled a landmine in ${channelId}, but none are left`);
          return;
        }

        let timedOut = "";
        if (config.landmine.timeout.enabled) {
          const seconds = config.landmine.timeout.seconds;
          const result = await discord.timeoutMember(
            guildId,
            userId,
            seconds,
            "Stepped on a landmine",
          );
          if (!result.ok) {
            mines.refund();
            console.error(`[LANDMINE] Could not time out ${userId}: ${result.error}`);
            return;
          }
          timedOut = ` and has been timed out for ${formatTime(seconds * 1000)}`;
        }

        const gif = config.landmine.gifs[Math.floor(random() * config.landmine.gifs.length)];
        console.log(`[LANDMINE] ${userId} stepped on one in ${channelId}; ${remaining} left`);
        const sent = await discord.sendMessage(
          channelId,
          `💥<@${userId}>💥 stepped on a landmine${timedOut}! ` +
            `(${remaining.toLocaleString("en-US")} landmines remaining)` +
            (gif ? `\n${gif}` : ""),
        );
        if (!sent.ok) console.error(`[LANDMINE] Could not announce in ${channelId}: ${sent.error}`);
      } catch (error) {
        console.error("[LANDMINE] Failed:", error);
      }
    },
  };
}
