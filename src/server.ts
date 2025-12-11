/**
 * HTTP Server Module
 *
 * Provides a lightweight HTTP server for health checks, manual triggers,
 * stats viewing, vote recording, and alert checking.
 */

import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { StorageService } from "./services/storage.ts";
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
 * @returns The Deno server instance
 */
export function createServer(
  config: AppConfig,
  discord: DiscordClient,
  storage: StorageService,
  dateFormatter: Intl.DateTimeFormat,
) {
  return Deno.serve(async (req) => {
    const url = new URL(req.url);

    // Health check endpoint for monitoring/load balancers
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Manual trigger for posting a poll
    if (url.pathname === "/trigger") {
      console.log("[SERVER] Manual trigger received!");

      try {
        const dateString = dateFormatter.format(new Date());
        const payload = buildMoodPollPayload(dateString, DEFAULT_MOOD_CONFIG);
        const response = await discord.postMessage(config.channelId, payload);

        if (response.ok) {
          console.log("[SERVER] Poll posted successfully!");
          return new Response("Poll triggered successfully!");
        } else {
          const body = await response.text();
          console.error(`[SERVER] Failed to post poll: ${response.status}`);
          console.error(body);
          return new Response(`Failed: ${body}`, { status: 500 });
        }
      } catch (error) {
        console.error("[SERVER] Error posting poll:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    }

    // Record a vote (for testing)
    // Usage: /vote?user=123&name=Alice&mood=glue
    if (url.pathname === "/vote") {
      const userId = url.searchParams.get("user");
      const userName = url.searchParams.get("name") ?? "TestUser";
      const mood = url.searchParams.get("mood") as Mood | null;
      const date = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0];

      if (!userId || !mood) {
        return new Response(
          "Missing required params: user, mood. Optional: name, date",
          { status: 400 },
        );
      }

      if (!["umazing", "ok", "glue"].includes(mood)) {
        return new Response("Invalid mood. Must be: umazing, ok, or glue", { status: 400 });
      }

      try {
        await storage.recordVote(userId, userName, mood, date);
        console.log(`[SERVER] Recorded vote: ${userName} (${userId}) = ${mood} on ${date}`);
        return new Response(`Vote recorded: ${userName} = ${mood} on ${date}`);
      } catch (error) {
        console.error("[SERVER] Error recording vote:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    }

    // Get stats and post to Discord as embed
    // Usage: /stats?days=7 (defaults to 7)
    if (url.pathname === "/stats") {
      const days = parseInt(url.searchParams.get("days") ?? "7", 10);
      const postToDiscord = url.searchParams.get("post") === "true";

      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const stats = await storage.getStats(
          startDate.toISOString().split("T")[0],
          endDate.toISOString().split("T")[0],
        );

        const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);

        if (postToDiscord) {
          const response = await discord.postMessage(config.channelId, embed);
          if (response.ok) {
            return new Response("Stats posted to Discord!");
          } else {
            const body = await response.text();
            return new Response(`Failed to post: ${body}`, { status: 500 });
          }
        }

        // Return stats as JSON for viewing
        return new Response(JSON.stringify({ stats, embed }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[SERVER] Error getting stats:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    }

    // Check for users at risk and optionally send alerts
    // Usage: /check-alerts?send=true (send=false just checks)
    if (url.pathname === "/check-alerts") {
      const sendAlerts = url.searchParams.get("send") === "true";

      try {
        const atRisk = await storage.getUsersAtRisk(config.glueAlertThreshold);

        if (atRisk.length === 0) {
          return new Response("No users at risk. Everyone is doing okay! 🎉");
        }

        const results = [];
        for (const userHistory of atRisk) {
          const user = userHistory[0];
          const alertEmbed = buildAlertEmbed(user.odUserName, userHistory.length);

          if (sendAlerts) {
            // Post alert to channel (or could DM the user)
            const response = await discord.postMessage(config.channelId, alertEmbed);
            results.push({
              user: user.odUserName,
              userId: user.odUserId,
              consecutiveDays: userHistory.length,
              alertSent: response.ok,
            });
          } else {
            results.push({
              user: user.odUserName,
              userId: user.odUserId,
              consecutiveDays: userHistory.length,
              alertSent: false,
            });
          }
        }

        return new Response(JSON.stringify({ usersAtRisk: results }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[SERVER] Error checking alerts:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    }

    // Get user history
    // Usage: /user-history?user=123
    if (url.pathname === "/user-history") {
      const userId = url.searchParams.get("user");

      if (!userId) {
        return new Response("Missing required param: user", { status: 400 });
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
        return new Response(`Error: ${error}`, { status: 500 });
      }
    }

    // Default response
    return new Response(
      "Weabot is running.\n\n" +
        "Endpoints:\n" +
        "  /health - Health check\n" +
        "  /trigger - Post a poll to Discord\n" +
        "  /vote?user=ID&mood=MOOD&name=NAME&date=DATE - Record a vote (testing)\n" +
        "  /stats?days=7&post=true - View or post stats\n" +
        "  /check-alerts?send=true - Check/send glue alerts\n" +
        "  /user-history?user=ID - View user's vote history\n",
      { status: 200 },
    );
  });
}
