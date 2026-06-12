/**
 * Scheduler Module
 *
 * Registers cron jobs for scheduled tasks:
 * - Daily mood poll (05:00 UTC)
 * - Daily wellness check (06:00 UTC, 1 hour after poll)
 * - Weekly stats summary (Sundays at 06:00 UTC)
 */

import type { AppConfig } from "./config.ts";
import type { AiService } from "../ai_service.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { RateLimitService } from "./services/rate_limit.ts";
import type { StorageService } from "./services/storage.ts";
import type { PollRecord } from "./types/storage.ts";
import type { Mood } from "./types/bot.ts";
import { getBotUserId } from "../bot_actions.ts";
import { decideAutonomousChatReply } from "./features/autonomous_chat/mod.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { buildAlertEmbed, buildStatsEmbed } from "./features/stats/mod.ts";
import { DEFAULT_MOOD_CONFIG } from "./types/bot.ts";

const AUTONOMOUS_CHAT_GUIDANCE =
  "Autonomous reply guidance: You are Haru joining an already-active group chat without being directly mentioned. Send one brief, natural message that responds to the latest context. Do not say this is automated, scheduled, or from a cron job. Do not force a reply if the context is sensitive; be supportive and concise. Keep it under 280 characters.";

/**
 * Registers all cron jobs for the application.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param storage - Storage service for vote data
 * @param dateFormatter - Date formatter for poll questions
 * @param aiService - AI service for autonomous chat replies
 * @param rateLimit - Rate limit service for AI budget tracking
 */
export function registerCronJobs(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
  aiService: AiService,
  rateLimit: RateLimitService,
): void {
  let autonomous_chat_running = false;

  // =========================================================================
  // Daily Mood Poll
  // Schedule: 05:00 UTC = 21:00 PST / 22:00 PDT
  // =========================================================================
  Deno.cron("Daily Retro Poll", "0 5 * * *", async () => {
    console.log("[CRON] Starting scheduled poll job...");

    try {
      const now = new Date();
      const dateString = dateFormatter.format(now);
      const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
      for (const channelId of config.channelIds) {
        const response = await discord.postMessage(channelId, payload);

        if (response.ok) {
          // Parse response to get message ID
          const messageData = await response.json();
          const messageId = messageData.id;

          // Save pending poll for later collection
          const pollRecord: PollRecord = {
            messageId,
            channelId,
            date: now.toISOString().split("T")[0],
            createdAt: Date.now(),
            expiresAt: Date.now() + (DEFAULT_MOOD_CONFIG.durationHours * 60 * 60 * 1000),
            collected: false,
          };

          await storage.savePendingPoll(pollRecord);
          console.log(`[CRON] Poll posted in ${channelId}! Message ID: ${messageId}`);
        } else {
          const body = await response.text();
          console.error(`[CRON] Failed to post poll in ${channelId}: ${response.status}`);
          console.error(body);
        }
      }
    } catch (error) {
      console.error("[CRON] Error posting poll:", error);
    }
  });

  // =========================================================================
  // Daily Wellness Check (Glue Alerts)
  // Schedule: 06:00 UTC = 22:00 PST / 23:00 PDT (1 hour after poll)
  // Checks if any user has consecutive "glue" days and sends supportive message
  // =========================================================================
  Deno.cron("Daily Wellness Check", "0 6 * * *", async () => {
    console.log("[CRON] Starting wellness check...");

    try {
      for (const channelId of config.channelIds) {
        const atRisk = await storage.getUsersAtRisk(channelId, config.glueAlertThreshold);

        if (atRisk.length === 0) {
          console.log(`[CRON] No users at risk in ${channelId}`);
          continue;
        }

        console.log(`[CRON] Found ${atRisk.length} user(s) at risk in ${channelId}`);

        for (const userHistory of atRisk) {
          const user = userHistory[0];
          const alertEmbed = buildAlertEmbed(user.odUserName, userHistory.length);
          const response = await discord.postMessage(channelId, alertEmbed);

          if (response.ok) {
            console.log(`[CRON] Alert sent for ${user.odUserName} in ${channelId}`);
          } else {
            console.error(`[CRON] Failed to send alert for ${user.odUserName} in ${channelId}`);
          }
        }
      }
    } catch (error) {
      console.error("[CRON] Error in wellness check:", error);
    }
  });

  // =========================================================================
  // Weekly Stats Summary
  // Schedule: Sundays at 06:00 UTC
  // Posts a summary of the week's mood trends
  // =========================================================================
  Deno.cron("Weekly Stats Summary", "0 6 * * SUN", async () => {
    console.log("[CRON] Starting weekly stats summary...");

    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      for (const channelId of config.channelIds) {
        const stats = await storage.getStats(
          channelId,
          startDate.toISOString().split("T")[0],
          endDate.toISOString().split("T")[0],
        );
        const embed = buildStatsEmbed(stats, "📊 Weekly Mood Summary");
        const response = await discord.postMessage(channelId, embed);

        if (response.ok) {
          console.log(`[CRON] Weekly stats posted in ${channelId}!`);
        } else {
          const body = await response.text();
          console.error(`[CRON] Failed to post weekly stats in ${channelId}: ${response.status}`);
          console.error(body);
        }
      }
    } catch (error) {
      console.error("[CRON] Error posting weekly stats:", error);
    }
  });

  // =========================================================================
  // Poll Result Collection
  // Schedule: Every hour at :30 minutes
  // Checks for expired polls and collects their results
  // =========================================================================
  Deno.cron("Poll Result Collection", "30 * * * *", async () => {
    console.log("[CRON] Checking for expired polls to collect...");

    try {
      const expiredPolls = await storage.getExpiredPolls();

      if (expiredPolls.length === 0) {
        console.log("[CRON] No expired polls to collect");
        return;
      }

      console.log(`[CRON] Found ${expiredPolls.length} expired poll(s) to collect`);

      for (const poll of expiredPolls) {
        try {
          console.log(`[CRON] Collecting results for poll ${poll.messageId} (${poll.date})`);

          // Fetch voters for each answer
          const answers = await discord.getPollVoters(poll.channelId, poll.messageId);

          // Map answer text to mood
          const moodMap: Record<string, Mood> = {
            umazing: "umazing",
            ok: "ok",
            glue: "glue",
          };

          let totalVotes = 0;

          for (const answer of answers) {
            const mood = moodMap[answer.answerText.toLowerCase()];
            if (!mood) {
              console.log(`[CRON] Unknown answer text: ${answer.answerText}`);
              continue;
            }

            for (const voter of answer.voters) {
              await storage.recordVote(
                poll.channelId,
                voter.odUserId,
                voter.odUserName,
                mood,
                poll.date,
              );
              totalVotes++;
            }
          }

          // Mark poll as collected
          await storage.markPollCollected(poll.messageId);
          console.log(`[CRON] Collected ${totalVotes} vote(s) from poll ${poll.messageId}`);
        } catch (pollError) {
          console.error(`[CRON] Error collecting poll ${poll.messageId}:`, pollError);
        }
      }
    } catch (error) {
      console.error("[CRON] Error in poll collection:", error);
    }
  });

  // =========================================================================
  // Autonomous Chat
  // Schedule: Every minute
  // Joins active conversations only when explicitly enabled and guardrails pass.
  // =========================================================================
  Deno.cron("Autonomous Chat", "* * * * *", async () => {
    if (!config.autonomousChatEnabled) return;
    if (!config.aiEnabled || !config.openaiApiKey) {
      console.log("[CRON] Autonomous chat skipped because AI is disabled or unconfigured");
      return;
    }
    if (autonomous_chat_running) {
      console.log("[CRON] Autonomous chat skipped because previous run is still active");
      return;
    }

    autonomous_chat_running = true;
    try {
      const bot_user_id = await getBotUserId(config);
      if (!bot_user_id) {
        console.error("[CRON] Autonomous chat skipped because bot user id is unavailable");
        return;
      }

      for (const channelId of config.autonomousChatChannelIds) {
        const recent_messages = await discord.getRecentMessages(
          channelId,
          config.autonomousChatMaxContextMessages,
        );
        const decision = decideAutonomousChatReply(recent_messages, {
          botUserId: bot_user_id,
          nowMs: Date.now(),
          minHumanMessages: config.autonomousChatMinHumanMessages,
          activityWindowMs: config.autonomousChatActivityWindowMinutes * 60_000,
          cooldownMs: config.autonomousChatCooldownMinutes * 60_000,
          maxContextMessages: config.autonomousChatMaxContextMessages,
          replyChance: config.autonomousChatReplyChance,
          random: Math.random,
        });

        if (!decision.shouldReply) {
          console.log(`[CRON] Autonomous chat skipped in ${channelId}: ${decision.reason}`);
          continue;
        }

        const budget_result = await rateLimit.checkDailyBudget();
        if (!budget_result.allowed) {
          console.log("[CRON] Autonomous chat skipped because daily token budget is exhausted");
          continue;
        }

        await rateLimit.recordUserRequest("autonomous-chat");
        const ai_result = await aiService.generateReply([
          ...decision.contextMessages,
          { author: "system", content: AUTONOMOUS_CHAT_GUIDANCE },
        ]);

        if (!ai_result.ok) {
          console.error(`[CRON] Autonomous chat AI failed in ${channelId}: ${ai_result.error}`);
          continue;
        }

        await rateLimit.recordTokenUsage(ai_result.tokensUsed);
        const response = await discord.postMessage(channelId, { content: ai_result.text });

        if (response.ok) {
          console.log(`[CRON] Autonomous chat posted in ${channelId}`);
        } else {
          const body = await response.text();
          console.error(`[CRON] Autonomous chat failed in ${channelId}: ${response.status}`);
          console.error(body);
        }
      }
    } catch (error) {
      console.error("[CRON] Error in autonomous chat:", error);
    } finally {
      autonomous_chat_running = false;
    }
  });

  console.log("[CRON] Registered jobs:");
  console.log("  - Daily Retro Poll (05:00 UTC)");
  console.log("  - Daily Wellness Check (06:00 UTC)");
  console.log("  - Weekly Stats Summary (Sundays 06:00 UTC)");
  console.log("  - Poll Result Collection (every hour at :30)");
  console.log("  - Autonomous Chat (every minute, disabled unless configured)");
}
