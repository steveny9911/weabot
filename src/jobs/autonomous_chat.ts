/** Joins active conversations only when explicitly enabled and every guardrail passes. */
import type { AiService } from "../ai/types.ts";
import { participateInChannel } from "../features/autonomous_chat/participate.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { JobDeps } from "./channel_posts.ts";
import { log } from "../app/log.ts";

/** Returns the job. It skips a run while the previous one is still active. `clock` is for tests. */
export function createAutonomousChatJob(
  { config, discord, storage }: JobDeps,
  aiService: AiService,
  rateLimit: RateLimitService,
  clock: { now?: () => number; random?: () => number } = {},
): () => Promise<void> {
  let autonomousChatRunning = false;

  return async () => {
    if (!config.autonomousChat.enabled) return;
    if (!config.aiEnabled || !config.aiApiKey) {
      log.debug("autonomous", "Autonomous chat skipped because AI is disabled or unconfigured");
      return;
    }
    if (autonomousChatRunning) {
      log.warn("autonomous", "Autonomous chat skipped because the previous run is still active");
      return;
    }

    autonomousChatRunning = true;
    try {
      const botUserId = await discord.getBotUserId();
      if (!botUserId) {
        log.error("autonomous", "Autonomous chat skipped because the bot user id is unavailable");
        return;
      }

      for (const channelId of config.autonomousChat.channelIds) {
        try {
          const outcome = await participateInChannel(channelId, {
            config,
            discord,
            storage,
            ai: aiService,
            rateLimit,
            botId: botUserId,
            ...clock,
          });
          log.debug("autonomous", "Outcome", { channelId, ...outcome });
        } catch (error) {
          log.warn("autonomous", "Autonomous chat skipped after a channel error", {
            channelId,
            error,
          });
        }
      }
    } catch (error) {
      log.error("autonomous", "Error in autonomous chat", { error });
    } finally {
      autonomousChatRunning = false;
    }
  };
}
