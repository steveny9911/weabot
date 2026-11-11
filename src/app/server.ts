import { timingSafeEqual } from "node:crypto";
import type { RateLimitService } from "../services/rate_limit.ts";
import { collectExpiredPolls } from "../jobs/collect_polls.ts";
import type { ChannelPost, JobDeps } from "../jobs/channel_posts.ts";
import { postMoodPolls } from "../jobs/mood_poll.ts";
import { lastDays, postStats } from "../jobs/stats.ts";
import { postTestAlert } from "../jobs/wellness.ts";
import { buildStatsEmbed } from "../features/stats.ts";
import { isMood, MOODS } from "../types/bot.ts";
import type { PollRecord } from "../types/storage.ts";

const WRITES = new Set([
  "/trigger",
  "/trigger_poll",
  "/trigger_stats",
  "/trigger_alert",
  "/trigger_collect",
  "/vote",
  "/add-pending-poll",
]);

const HELP = `🐴 Haru is running!

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
`;

const json = (body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json" } });
const today = () => new Date().toISOString().split("T")[0];

/** Lists each channel's result; succeeds if at least one channel got the post. */
function postReport(posts: ChannelPost[], title: string, showDetail = false): Response {
  // A job posts nothing only when its feature is disabled.
  if (posts.length === 0) {
    return new Response("ℹ️ Nothing posted: this feature is disabled in config.yaml", {
      status: 409,
    });
  }
  const lines = posts.map((post) =>
    post.ok
      ? `✅ ${post.channelId}${showDetail ? `: ${post.detail}` : ""}`
      : `❌ ${post.channelId}: ${post.detail}`,
  );
  return posts.some((post) => post.ok)
    ? new Response(`${title}:\n${lines.join("\n")}`)
    : new Response(`❌ Failed:\n${lines.join("\n")}`, { status: 500 });
}

/** What the admin routes read and post with; `rateLimit` backs /ai-usage. */
type ServerDeps = JobDeps & { rateLimit?: RateLimitService };

/** Health is public; every other route needs `ADMIN_HTTP_TOKEN` and is off without it. */
export function createRequestHandler({ rateLimit, ...deps }: ServerDeps) {
  const { config, discord, storage } = deps;
  const defaultChannel = config.channelIds[0];

  const routes: Record<string, [label: string, run: (url: URL) => Promise<Response>]> = {
    "/trigger_poll": [
      "posting poll",
      async () => {
        console.log("[SERVER] Triggering poll...");
        return postReport(await postMoodPolls(deps, "[SERVER]"), "Poll posted", true);
      },
    ],
    "/trigger_stats": [
      "posting stats",
      async (url) => {
        const days = parseInt(url.searchParams.get("days") ?? "7", 10);
        console.log(`[SERVER] Triggering stats (last ${days} days)...`);
        const posts = await postStats(deps, {
          days,
          title: `📊 Mood Stats (Last ${days} Days)`,
          label: "stats",
          tag: "[SERVER]",
        });
        return postReport(posts, "✅ Stats embed posted");
      },
    ],
    "/trigger_alert": [
      "posting alert",
      async (url) => {
        const userName = url.searchParams.get("name") ?? "TestUser";
        const days = parseInt(url.searchParams.get("days") ?? "7", 10);
        console.log(`[SERVER] Triggering alert for ${userName} (${days} days)...`);
        return postReport(await postTestAlert(deps, userName, days), "✅ Alert embed posted");
      },
    ],
    "/trigger_collect": [
      "collecting polls",
      async () => {
        console.log("[SERVER] Triggering poll result collection...");
        const { collected, failed } = await collectExpiredPolls(discord, storage);
        if (collected.length === 0 && failed.length === 0) {
          return new Response("ℹ️ No expired polls to collect");
        }
        const totalVotes = collected.reduce((total, result) => total + result.votes, 0);
        const lines = [
          ...collected.map(
            ({ poll, votes }) => `Poll ${poll.messageId} (${poll.date}): ${votes} votes`,
          ),
          ...failed.map(
            ({ poll }) => `Poll ${poll.messageId} (${poll.date}): failed; pending retry`,
          ),
        ];
        const icon = failed.length ? "❌" : "✅";
        return new Response(
          `${icon} Collected ${totalVotes} votes from ${collected.length} poll(s); ${failed.length} failed\n\n${lines.join("\n")}`,
          { status: failed.length ? 500 : 200 },
        );
      },
    ],
    "/vote": [
      "recording vote",
      async (url) => {
        const channelId = url.searchParams.get("channelId") ?? defaultChannel;
        const userId = url.searchParams.get("user");
        const userName = url.searchParams.get("name") ?? "TestUser";
        const mood = url.searchParams.get("mood");
        const date = url.searchParams.get("date") ?? today();
        if (!userId || !mood) {
          return new Response(
            "Missing required params: user, mood. Optional: name, date, channelId\n" +
              "Example: /vote?user=123&mood=glue&name=Alice&date=2025-12-11&channelId=123456789",
            { status: 400 },
          );
        }
        if (!isMood(mood)) {
          return new Response(`Invalid mood. Must be one of: ${MOODS.join(", ")}`, { status: 400 });
        }
        await storage.recordVote(channelId, userId, userName, mood, date);
        console.log(
          `[SERVER] Recorded vote in ${channelId}: ${userName} (${userId}) = ${mood} on ${date}`,
        );
        return new Response(`✅ Vote recorded in ${channelId}: ${userName} = ${mood} on ${date}`);
      },
    ],
    "/stats": [
      "getting stats",
      async (url) => {
        const channelId = url.searchParams.get("channelId") ?? defaultChannel;
        const days = parseInt(url.searchParams.get("days") ?? "7", 10);
        const { start, end } = lastDays(days);
        const stats = await storage.getStats(channelId, start, end);
        const embed = buildStatsEmbed(stats, `📊 Mood Stats (Last ${days} Days)`);
        return json({ channelId, stats, embed });
      },
    ],
    "/check-alerts": [
      "checking alerts",
      async () => {
        const results = [];
        for (const channelId of config.wellness.channelIds) {
          const atRisk = await storage.getUsersAtRisk(
            channelId,
            config.wellness.glueAlertThreshold,
          );
          results.push({
            channelId,
            usersAtRisk: atRisk.map((history) => ({
              user: history[0].userName,
              odUserId: history[0].userId,
              consecutiveDays: history.length,
            })),
          });
        }
        if (results.every((entry) => entry.usersAtRisk.length === 0)) {
          return new Response("✅ No users at risk. Everyone is doing okay! 🎉");
        }
        return json({ results });
      },
    ],
    "/user-history": [
      "getting user history",
      async (url) => {
        const channelId = url.searchParams.get("channelId") ?? defaultChannel;
        const userId = url.searchParams.get("user");
        if (!userId) {
          return new Response(
            "Missing required param: user\nExample: /user-history?user=123&channelId=123456789",
            { status: 400 },
          );
        }
        const history = await storage.getUserHistory(channelId, userId);
        const consecutiveGlue = await storage.getConsecutiveGlueCount(channelId, userId);
        return json({ channelId, userId, consecutiveGlue, history });
      },
    ],
    "/ai-usage": [
      "getting AI usage",
      async () => {
        if (!rateLimit) {
          return new Response(JSON.stringify({ error: "Rate limit service not configured" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        const stats = await rateLimit.getUsageStats();
        const budgetPercentage = (stats.dailyTokensUsed / stats.dailyTokenBudget) * 100;
        return json({
          daily_tokens_used: stats.dailyTokensUsed,
          daily_token_budget: stats.dailyTokenBudget,
          budget_percentage: Math.round(budgetPercentage * 100) / 100,
          requests_today: stats.requestsToday,
          ai_enabled: config.aiEnabled,
          rate_limit_per_user: config.aiRateLimitPerUser,
        });
      },
    ],
    "/pending-polls": [
      "getting pending polls",
      async () => {
        const expiredPolls = await storage.getExpiredPolls();
        const allPending = await storage.getAllPendingPolls();
        return json({
          expired_ready_to_collect: expiredPolls.length,
          expired_polls: expiredPolls,
          all_pending: allPending.length,
          pending_polls: allPending,
        });
      },
    ],
    "/add-pending-poll": [
      "adding pending poll",
      async (url) => {
        const messageId = url.searchParams.get("messageId");
        if (!messageId) {
          return new Response(
            "Missing required param: messageId\n" +
              "Example: /add-pending-poll?messageId=123456789&expiresIn=0",
            { status: 400 },
          );
        }
        const expiresInMs = parseInt(url.searchParams.get("expiresIn") ?? "0", 10);
        const pollRecord: PollRecord = {
          messageId,
          channelId: url.searchParams.get("channelId") ?? defaultChannel,
          date: url.searchParams.get("date") ?? today(),
          createdAt: Date.now(),
          expiresAt: Date.now() + expiresInMs,
          collected: false,
        };
        await storage.savePendingPoll(pollRecord);
        return new Response(`✅ Added pending poll:\n${JSON.stringify(pollRecord, null, 2)}`);
      },
    ],
  };
  routes["/trigger"] = routes["/trigger_poll"];

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("OK", { status: 200 });

    if (!config.adminHttpToken) return new Response("Not found", { status: 404 });
    const expected = new TextEncoder().encode(`Bearer ${config.adminHttpToken}`);
    const supplied = new TextEncoder().encode(req.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const method = WRITES.has(url.pathname) ? "POST" : "GET";
    if (req.method !== method) {
      return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
    }

    const route = routes[url.pathname];
    if (!route) return new Response(HELP, { status: 200 });
    const [label, run] = route;
    try {
      return await run(url);
    } catch (error) {
      console.error(`[SERVER] Error ${label}:`, error);
      return new Response(`❌ Error: ${error}`, { status: 500 });
    }
  };
}

export function serverError(error: Error): Response {
  console.error("[SERVER] Request failed:", error);
  return new Response("Internal Server Error", { status: 500 });
}

export function serverOptions(handler: (req: Request) => Promise<Response>, port = 8000) {
  return {
    port,
    development: false,
    // Admin routes can outlast Bun's 10 s default; a request silent for 120 s is cut off.
    idleTimeout: 120,
    fetch: handler,
    error: serverError,
  } satisfies Bun.Serve.Options<undefined>;
}

export function createServer(deps: ServerDeps, port = 8000) {
  return Bun.serve(serverOptions(createRequestHandler(deps), port));
}
