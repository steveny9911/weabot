/** Joins active conversations only when explicitly enabled and every guardrail passes. */
import type { AiService } from "../ai/types.ts";
import { getBotUserId } from "../discord/messages.ts";
import { participateInChannel } from "../features/autonomous_chat/participate.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { JobDeps } from "./channel_posts.ts";

/** Returns the job. It skips a run while the previous one is still active. */
export function createAutonomousChatJob(
  { config, discord, storage }: JobDeps,
  aiService: AiService,
  rateLimit: RateLimitService,
): () => Promise<void> {
  let autonomousChatRunning = false;

  return async () => {
    if (!config.autonomousChatEnabled) return;
    if (!config.aiEnabled || !config.openaiApiKey) {
      console.log("[CRON] Autonomous chat skipped because AI is disabled or unconfigured");
      return;
    }
    if (autonomousChatRunning) {
      console.log("[CRON] Autonomous chat skipped because previous run is still active");
      return;
    }

    autonomousChatRunning = true;
    try {
      const botUserId = await getBotUserId(config);
      if (!botUserId) {
        console.error("[CRON] Autonomous chat skipped because bot user id is unavailable");
        return;
      }

      for (const channelId of config.autonomousChatChannelIds) {
        try {
          const outcome = await participateInChannel(channelId, {
            config,
            discord,
            storage,
            ai: aiService,
            rateLimit,
            botId: botUserId,
          });
          console.log("[AUTONOMOUS OUTCOME]", JSON.stringify({ channelId, ...outcome }));
        } catch {
          console.warn(`[CRON] Autonomous chat skipped in ${channelId} after a channel error`);
        }
      }
    } catch (error) {
      console.error("[CRON] Error in autonomous chat:", error);
    } finally {
      autonomousChatRunning = false;
    }
  };
}
