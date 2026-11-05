/**
 * HTTP Server Module
 *
 * Provides a lightweight HTTP server for health checks, manual triggers,
 * stats viewing, vote recording, and alert checking.
 */

import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { StorageService } from "./services/storage.ts";
import { collectExpiredPolls } from "./services/poll_collection.ts";
import type { RateLimitService } from "./services/rate_limit.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { buildAlertEmbed, buildStatsEmbed } from "./features/stats/mod.ts";
import { DEFAULT_MOOD_CONFIG, type Mood } from "./types/bot.ts";
import type { PollRecord } from "./types/storage.ts";

/**
 * Creates the HTTP request handler with health and authenticated administration.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param storage - Storage service for vote persistence
 * @param dateFormatter - Date formatter for poll questions
 * @param rateLimit - Rate limit service for AI usage tracking (optional)
 * @returns The handler used by the production server and isolated tests
 */
export function createRequestHandler(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
  rateLimit?: RateLimitService,
) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // =========================================================================
    // Health Check
    // =========================================================================
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Health is the only unauthenticated route. Administrative routes are
    // disabled everywhere until an operator explicitly configures a token.
    if (!config.adminHttpToken) return new Response("Not found", { status: 404 });
    const expected = new TextEncoder().encode(`Bearer ${config.adminHttpToken}`);
    const supplied = new TextEncoder().encode(req.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const writes = new Set([
      "/trigger",
      "/trigger_poll",
      "/trigger_stats",
      "/trigger_alert",
      "/trigger_collect",
      "/vote",
      "/add-pending-poll",
    ]);
    const method = writes.has(url.pathname) ? "POST" : "GET";
    if (req.method !== method) {
      return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
    }

    // =========================================================================
    // TRIGGER ENDPOINTS - Post directly to Discord for testing
    // =========================================================================

    // Trigger: Post a mood poll
    if (url.pathname === "/trigger" || url.pathname === "/trigger_poll") {
      console.log("[SERVER] Triggering poll...");

      try {
        const now = new Date();
        const dateString = dateFormatter.format(now);
        const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
        const results: string[] = [];
        let successCount = 0;

        for (const channelId of config.channelIds) {
          const response = await discord.postMessage(channelId, payload);

          if (response.ok) {
            // Parse response to get message ID and save for collection
            const messageData = await response.json();
            const messageId = messageData.id;

            const pollRecord: PollRecord = {
              messageId,
              channelId,
              date: now.toISOString().split("T")[0],
              createdAt: Date.now(),
              expiresAt: Date.now() + (DEFAULT_MOOD_CONFIG.durationHours * 60 * 60 * 1000),
              collected: false,
            };

            await storage.savePendingPoll(pollRecord);
            console.log(`[SERVER] Poll posted in ${channelId}! Message ID: ${messageId}`);
            results.push(`✅ ${channelId}: ${messageId}`);
            successCount++;
          } else {
            const body = await response.text();
            console.error(`[SERVER] Failed to post poll in ${channelId}: ${response.status}`);
            results.push(`❌ ${channelId}: ${body}`);
          }
        }

        if (successCount > 0) {
          return new Response(`Poll posted:\n${results.join("\n")}`);
        }
        return new Response(`❌ Failed:\n${results.join("\n")}`, { status: 500 });
      } catch (error) {
        console.error("[SERVER] Error posting poll:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Trigger: Post weekly stats embed
    if (url.pathname === "/trigger_stats") {
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);
      console.log(`[SERVER] Triggering stats (last ${days} days)...`);

      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const results: string[] = [];
        let successCount = 0;

        for (const channelId of config.channelIds) {
          const stats = await storage.getStats(
            channelId,
            startDate.toISOString().split("T")[0],
            endDate.toISOString().split("T")[0],
          );
          const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);
          const response = await discord.postMessage(channelId, embed);

          if (response.ok) {
            console.log(`[SERVER] Stats posted in ${channelId}!`);
            results.push(`✅ ${channelId}`);
            successCount++;
          } else {
            const body = await response.text();
            console.error(`[SERVER] Failed to post stats in ${channelId}: ${response.status}`);
            results.push(`❌ ${channelId}: ${body}`);
          }
        }

        if (successCount > 0) {
          return new Response(`✅ Stats embed posted:\n${results.join("\n")}`);
        }
        return new Response(`❌ Failed:\n${results.join("\n")}`, { status: 500 });
      } catch (error) {
        console.error("[SERVER] Error posting stats:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Trigger: Post wellness alert (uses test user if no real users at risk)
    if (url.pathname === "/trigger_alert") {
      const userName = url.searchParams.get("name") ?? "TestUser";
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);
      console.log(`[SERVER] Triggering alert for ${userName} (${days} days)...`);

      try {
        const alertEmbed = buildAlertEmbed(userName, days);
        const results: string[] = [];
        let successCount = 0;

        for (const channelId of config.channelIds) {
          const response = await discord.postMessage(channelId, alertEmbed);

          if (response.ok) {
            console.log(`[SERVER] Alert posted in ${channelId}!`);
            results.push(`✅ ${channelId}`);
            successCount++;
          } else {
            const body = await response.text();
            console.error(`[SERVER] Failed to post alert in ${channelId}: ${response.status}`);
            results.push(`❌ ${channelId}: ${body}`);
          }
        }

        if (successCount > 0) {
          return new Response(`✅ Alert embed posted:\n${results.join("\n")}`);
        }
        return new Response(`❌ Failed:\n${results.join("\n")}`, { status: 500 });
      } catch (error) {
        console.error("[SERVER] Error posting alert:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Trigger: Collect expired poll results
    if (url.pathname === "/trigger_collect") {
      console.log("[SERVER] Triggering poll result collection...");

      try {
        const { collected, failed } = await collectExpiredPolls(discord, storage);
        if (collected.length === 0 && failed.length === 0) {
          return new Response("ℹ️ No expired polls to collect");
        }
        const totalVotes = collected.reduce((total, result) => total + result.votes, 0);
        const results = [
          ...collected.map(({ poll, votes }) =>
            `Poll ${poll.messageId} (${poll.date}): ${votes} votes`
          ),
          ...failed.map(({ poll }) =>
            `Poll ${poll.messageId} (${poll.date}): failed; pending retry`
          ),
        ];
        return new Response(
          `${
            failed.length ? "❌" : "✅"
          } Collected ${totalVotes} votes from ${collected.length} poll(s); ${failed.length} failed\n\n${
            results.join("\n")
          }`,
          { status: failed.length ? 500 : 200 },
        );
      } catch (error) {
        console.error("[SERVER] Error collecting polls:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // =========================================================================
    // DATA ENDPOINTS - View/modify data without posting to Discord
    // =========================================================================

    // Record a vote (for testing)
    if (url.pathname === "/vote") {
      const channelId = url.searchParams.get("channelId") ?? config.channelId;
      const userId = url.searchParams.get("user");
      const userName = url.searchParams.get("name") ?? "TestUser";
      const mood = url.searchParams.get("mood") as Mood | null;
      const date = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0];

      if (!userId || !mood) {
        return new Response(
          "Missing required params: user, mood. Optional: name, date, channelId\n" +
            "Example: /vote?user=123&mood=glue&name=Alice&date=2025-12-11&channelId=123456789",
          { status: 400 },
        );
      }

      if (!["umazing", "ok", "glue"].includes(mood)) {
        return new Response("Invalid mood. Must be: umazing, ok, or glue", { status: 400 });
      }

      try {
        await storage.recordVote(channelId, userId, userName, mood, date);
        console.log(
          `[SERVER] Recorded vote in ${channelId}: ${userName} (${userId}) = ${mood} on ${date}`,
        );
        return new Response(
          `✅ Vote recorded in ${channelId}: ${userName} = ${mood} on ${date}`,
        );
      } catch (error) {
        console.error("[SERVER] Error recording vote:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Get stats as JSON (without posting)
    if (url.pathname === "/stats") {
      const channelId = url.searchParams.get("channelId") ?? config.channelId;
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);

      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const stats = await storage.getStats(
          channelId,
          startDate.toISOString().split("T")[0],
          endDate.toISOString().split("T")[0],
        );

        const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);

        return new Response(JSON.stringify({ channelId, stats, embed }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[SERVER] Error getting stats:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Check for users at risk (without sending alerts)
    if (url.pathname === "/check-alerts") {
      try {
        const results = [];

        for (const channelId of config.channelIds) {
          const atRisk = await storage.getUsersAtRisk(channelId, config.glueAlertThreshold);
          results.push({
            channelId,
            usersAtRisk: atRisk.map((userHistory) => ({
              user: userHistory[0].odUserName,
              odUserId: userHistory[0].odUserId,
              consecutiveDays: userHistory.length,
            })),
          });
        }

        if (results.every((entry) => entry.usersAtRisk.length === 0)) {
          return new Response("✅ No users at risk. Everyone is doing okay! 🎉");
        }

        return new Response(JSON.stringify({ results }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[SERVER] Error checking alerts:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Get user history
    if (url.pathname === "/user-history") {
      const channelId = url.searchParams.get("channelId") ?? config.channelId;
      const userId = url.searchParams.get("user");

      if (!userId) {
        return new Response(
          "Missing required param: user\nExample: /user-history?user=123&channelId=123456789",
          {
            status: 400,
          },
        );
      }

      try {
        const history = await storage.getUserHistory(channelId, userId);
        const consecutiveGlue = await storage.getConsecutiveGlueCount(channelId, userId);

        return new Response(
          JSON.stringify({ channelId, userId, consecutiveGlue, history }, null, 2),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("[SERVER] Error getting user history:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // =========================================================================
    // AI USAGE MONITORING
    // =========================================================================

    // Get AI usage statistics
    if (url.pathname === "/ai-usage") {
      if (!rateLimit) {
        return new Response(
          JSON.stringify({ error: "Rate limit service not configured" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      try {
        const stats = await rateLimit.getUsageStats();
        const budgetPercentage = (stats.dailyTokensUsed / stats.dailyTokenBudget) * 100;

        return new Response(
          JSON.stringify(
            {
              daily_tokens_used: stats.dailyTokensUsed,
              daily_token_budget: stats.dailyTokenBudget,
              budget_percentage: Math.round(budgetPercentage * 100) / 100,
              requests_today: stats.requestsToday,
              ai_enabled: config.aiEnabled,
              rate_limit_per_user: config.aiRateLimitPerUser,
            },
            null,
            2,
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("[SERVER] Error getting AI usage:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Get pending polls awaiting collection
    if (url.pathname === "/pending-polls") {
      try {
        const expiredPolls = await storage.getExpiredPolls();
        const allPending = await storage.getAllPendingPolls();

        return new Response(
          JSON.stringify(
            {
              expired_ready_to_collect: expiredPolls.length,
              expired_polls: expiredPolls,
              all_pending: allPending.length,
              pending_polls: allPending,
            },
            null,
            2,
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("[SERVER] Error getting pending polls:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Add a poll to pending (for testing)
    if (url.pathname === "/add-pending-poll") {
      const messageId = url.searchParams.get("messageId");
      const channelId = url.searchParams.get("channelId") ?? config.channelId;
      const date = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
      const expiresInMs = parseInt(url.searchParams.get("expiresIn") ?? "0", 10);

      if (!messageId) {
        return new Response(
          "Missing required param: messageId\n" +
            "Example: /add-pending-poll?messageId=123456789&expiresIn=0",
          { status: 400 },
        );
      }

      try {
        const pollRecord: PollRecord = {
          messageId,
          channelId,
          date,
          createdAt: Date.now(),
          expiresAt: Date.now() + expiresInMs,
          collected: false,
        };

        await storage.savePendingPoll(pollRecord);

        return new Response(
          `✅ Added pending poll:\n${JSON.stringify(pollRecord, null, 2)}`,
        );
      } catch (error) {
        console.error("[SERVER] Error adding pending poll:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // =========================================================================
    // Default: Show help
    // =========================================================================
    return new Response(
      `🐴 Haru is running!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRIGGER ENDPOINTS (post to Discord)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /trigger_poll             Post a mood poll
  /trigger_stats?days=7     Post stats embed
  /trigger_alert?name=Test  Post wellness alert
  /trigger_collect          Collect expired poll results

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA ENDPOINTS (view/modify data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /vote?user=ID&mood=MOOD   Record a vote
  /stats?days=7             View channel stats as JSON
  /check-alerts             Check who's at risk
  /user-history?user=ID     View channel-scoped user history
  /pending-polls            View polls awaiting collection
  /add-pending-poll?...     Add a poll for testing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AI & MONITORING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /ai-usage                 View AI token usage
  /health                   Health check
`,
      { status: 200 },
    );
  };
}

/** Start the production HTTP server with the same policy used by handler tests. */
export function createServer(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
  rateLimit?: RateLimitService,
) {
  return Deno.serve(createRequestHandler(config, discord, storage, dateFormatter, rateLimit));
}
