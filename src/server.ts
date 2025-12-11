/**
 * HTTP Server Module
 *
 * Provides a lightweight HTTP server for health checks and manual triggers.
 * Uses the factory pattern to accept dependencies as arguments,
 * enabling testability without mocking globals.
 */

import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import { buildMoodPollPayload } from "./features/poll/mod.ts";
import { DEFAULT_MOOD_CONFIG } from "./types/bot.ts";

/**
 * Creates and starts the HTTP server.
 *
 * @param config - Application configuration
 * @param discord - Discord API client
 * @param dateFormatter - Date formatter for poll questions
 * @returns The Deno server instance
 */
export function createServer(
  config: AppConfig,
  discord: DiscordClient,
  dateFormatter: Intl.DateTimeFormat,
) {
  return Deno.serve(async (req) => {
    const url = new URL(req.url);

    // Health check endpoint for monitoring/load balancers
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Manual trigger for testing without waiting for cron
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

    // Default response
    return new Response(
      "Weabot is running. Endpoints: /health, /trigger",
      { status: 200 },
    );
  });
}
