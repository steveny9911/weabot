/** Landmines: any message may be one. Haru announces who stepped on it and can time them out. */
import type { AppConfig } from "../config.ts";
import { formatTime, isCommand } from "../bot/commands.ts";
import { isActiveIn } from "../feature_config.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { createLandmineQueries } from "../db/landmines.ts";
import { buildLandmineReport, reportStart, type ReportPeriod } from "./landmine_report.ts";
import type { EmbedMessagePayload } from "./stats.ts";
import { log } from "../app/log.ts";

export interface LandmineService {
  /** Rolls one message; on a landmine announces it, and times the author out if enabled. Never throws. */
  step(message: Record<string, unknown>): Promise<void>;
  /** The leaderboard of the last week or month, up to `now`. */
  report(period: ReportPeriod, now?: number): EmbedMessagePayload;
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
    report(period, now = Date.now()) {
      return buildLandmineReport(
        period,
        mines.stepsSince(reportStart(period, now)),
        mines.remaining(),
      );
    },
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
        log.debug("landmine", "Safe", { userId, channelId, roll: Number(roll.toFixed(3)) });
        return;
      }

      try {
        const remaining = mines.claim();
        if (remaining === null) {
          log.info("landmine", "Rolled a landmine, but none are left", { userId, channelId });
          return;
        }

        let timedOut = "";
        if (config.landmine.stepPenalty.enabled) {
          const seconds = config.landmine.stepPenalty.timeoutSeconds;
          const result = await discord.timeoutMember(
            guildId,
            userId,
            seconds,
            "Stepped on a landmine",
          );
          if (!result.ok) {
            mines.refund();
            log.error("landmine", "Could not time out", { userId, error: result.error });
            return;
          }
          timedOut = ` and has been timed out for ${formatTime(seconds * 1000)}`;
        }
        // The step is final once claimed and timed out, so it counts even if the announcement fails.
        mines.recordStep(userId);

        const gif = config.landmine.gifs[Math.floor(random() * config.landmine.gifs.length)];
        log.info("landmine", "Stepped on a landmine", { userId, channelId, remaining });
        const sent = await discord.sendMessage(
          channelId,
          `💥<@${userId}>💥 stepped on a landmine${timedOut}! ` +
            `(${remaining.toLocaleString("en-US")} landmines remaining)` +
            (gif ? `\n${gif}` : ""),
        );
        if (!sent.ok) log.error("landmine", "Could not announce", { channelId, error: sent.error });
      } catch (error) {
        log.error("landmine", "Failed", { err: error });
      }
    },
  };
}
