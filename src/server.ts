/**
 * HTTP Server Module
 *
 * Provides a lightweight HTTP server for health checks, manual triggers,
 * stats viewing, vote recording, and alert checking.
 */

import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { StorageService } from "./services/storage.ts";
import type { RateLimitService } from "./services/rate_limit.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { buildAlertEmbed, buildStatsEmbed } from "./features/stats/mod.ts";
import { DEFAULT_MOOD_CONFIG, type Mood } from "./types/bot.ts";

/**
 * Creates and starts the HTTP server.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param storage - Storage service for vote persistence
 * @param dateFormatter - Date formatter for poll questions
 * @param rateLimit - Rate limit service for AI usage tracking (optional)
 * @returns The Deno server instance
 */
export function createServer(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
  rateLimit?: RateLimitService,
) {
  return Deno.serve(async (req) => {
    const url = new URL(req.url);

    // =========================================================================
    // Health Check
    // =========================================================================
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // =========================================================================
    // TRIGGER ENDPOINTS - Post directly to Discord for testing
    // =========================================================================

    // Trigger: Post a mood poll
    if (url.pathname === "/trigger" || url.pathname === "/trigger_poll") {
      console.log("[SERVER] Triggering poll...");

      try {
        const dateString = dateFormatter.format(new Date());
        const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
        const response = await discord.postMessage(config.channelId, payload);

        if (response.ok) {
          console.log("[SERVER] Poll posted successfully!");
          return new Response("✅ Poll posted to Discord!");
        } else {
          const body = await response.text();
          console.error(`[SERVER] Failed to post poll: ${response.status}`);
          return new Response(`❌ Failed: ${body}`, { status: 500 });
        }
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

        const stats = await storage.getStats(
          startDate.toISOString().split("T")[0],
          endDate.toISOString().split("T")[0],
        );

        const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);
        const response = await discord.postMessage(config.channelId, embed);

        if (response.ok) {
          console.log("[SERVER] Stats posted successfully!");
          return new Response("✅ Stats embed posted to Discord!");
        } else {
          const body = await response.text();
          console.error(`[SERVER] Failed to post stats: ${response.status}`);
          return new Response(`❌ Failed: ${body}`, { status: 500 });
        }
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
        const response = await discord.postMessage(config.channelId, alertEmbed);

        if (response.ok) {
          console.log("[SERVER] Alert posted successfully!");
          return new Response("✅ Alert embed posted to Discord!");
        } else {
          const body = await response.text();
          console.error(`[SERVER] Failed to post alert: ${response.status}`);
          return new Response(`❌ Failed: ${body}`, { status: 500 });
        }
      } catch (error) {
        console.error("[SERVER] Error posting alert:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // =========================================================================
    // DATA ENDPOINTS - View/modify data without posting to Discord
    // =========================================================================

    // Record a vote (for testing)
    if (url.pathname === "/vote") {
      const userId = url.searchParams.get("user");
      const userName = url.searchParams.get("name") ?? "TestUser";
      const mood = url.searchParams.get("mood") as Mood | null;
      const date = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0];

      if (!userId || !mood) {
        return new Response(
          "Missing required params: user, mood. Optional: name, date\n" +
            "Example: /vote?user=123&mood=glue&name=Alice&date=2025-12-11",
          { status: 400 },
        );
      }

      if (!["umazing", "ok", "glue"].includes(mood)) {
        return new Response("Invalid mood. Must be: umazing, ok, or glue", { status: 400 });
      }

      try {
        await storage.recordVote(userId, userName, mood, date);
        console.log(`[SERVER] Recorded vote: ${userName} (${userId}) = ${mood} on ${date}`);
        return new Response(`✅ Vote recorded: ${userName} = ${mood} on ${date}`);
      } catch (error) {
        console.error("[SERVER] Error recording vote:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Get stats as JSON (without posting)
    if (url.pathname === "/stats") {
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);

      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const stats = await storage.getStats(
          startDate.toISOString().split("T")[0],
          endDate.toISOString().split("T")[0],
        );

        const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);

        return new Response(JSON.stringify({ stats, embed }, null, 2), {
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
        const atRisk = await storage.getUsersAtRisk(config.glueAlertThreshold);

        if (atRisk.length === 0) {
          return new Response("✅ No users at risk. Everyone is doing okay! 🎉");
        }

        const results = atRisk.map((userHistory) => ({
          user: userHistory[0].odUserName,
          odUserId: userHistory[0].odUserId,
          consecutiveDays: userHistory.length,
        }));

        return new Response(JSON.stringify({ usersAtRisk: results }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[SERVER] Error checking alerts:", error);
        return new Response(`❌ Error: ${error}`, { status: 500 });
      }
    }

    // Get user history
    if (url.pathname === "/user-history") {
      const userId = url.searchParams.get("user");

      if (!userId) {
        return new Response("Missing required param: user\nExample: /user-history?user=123", {
          status: 400,
        });
      }

      try {
        const history = await storage.getUserHistory(userId);
        const consecutiveGlue = await storage.getConsecutiveGlueCount(userId);

        return new Response(
          JSON.stringify({ userId, consecutiveGlue, history }, null, 2),
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
        const budget_percentage = (stats.dailyTokensUsed / stats.dailyTokenBudget) * 100;

        return new Response(
          JSON.stringify({
            daily_tokens_used: stats.dailyTokensUsed,
            daily_token_budget: stats.dailyTokenBudget,
            budget_percentage: Math.round(budget_percentage * 100) / 100,
            requests_today: stats.requestsToday,
            ai_enabled: config.aiEnabled,
            rate_limit_per_user: config.aiRateLimitPerUser,
          }, null, 2),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("[SERVER] Error getting AI usage:", error);
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA ENDPOINTS (view/modify data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /vote?user=ID&mood=MOOD   Record a vote
  /stats?days=7             View stats as JSON
  /check-alerts             Check who's at risk
  /user-history?user=ID     View user history

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OTHER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /health                   Health check
`,
      { status: 200 },
    );
  });
}
