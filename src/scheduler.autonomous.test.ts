import { assert, assertEquals } from "@std/assert";
import type { AiResult } from "../ai_service.ts";
import type { AppConfig } from "./config.ts";
import { registerCronJobs } from "./scheduler.ts";
import { createRateLimitService } from "./services/rate_limit.ts";
import { createStorageService } from "./services/storage.ts";

function config(): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "channel",
    channelIds: ["channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "test-key",
    aiRateLimitPerUser: 1,
    aiDailyTokenBudget: 100,
    aiMaxInputChars: 500,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: true,
    autonomousChatChannelIds: ["channel"],
    autonomousChatMinHumanMessages: 1,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 1,
    autonomousChatMaxContextMessages: 40,
  };
}

async function withAutonomousJob(
  result: AiResult,
  test: (fixture: {
    run: () => Promise<void>;
    rateLimit: ReturnType<typeof createRateLimitService>;
    aiCalls: () => number;
    posts: string[];
  }) => Promise<void>,
) {
  const kv = await Deno.openKv(":memory:");
  const originalCron = Deno.cron;
  const originalFetch = globalThis.fetch;
  const jobs = new Map<string, () => Promise<void>>();
  Deno.cron = ((name, _schedule, handler) => {
    jobs.set(name, handler as () => Promise<void>);
    return Promise.resolve();
  }) as typeof Deno.cron;
  globalThis.fetch = () => Promise.resolve(Response.json({ id: "bot" }));
  try {
    const settings = config();
    const rateLimit = createRateLimitService(
      kv,
      settings,
      () => Date.parse("2026-09-05T12:34:00Z"),
    );
    let aiCalls = 0;
    const posts: string[] = [];
    registerCronJobs(
      settings,
      {
        postMessage(_channel, payload) {
          assert("content" in payload);
          posts.push(payload.content);
          return Promise.resolve(Response.json({ id: "reply" }));
        },
        sendDM: () => Promise.reject(new Error("unexpected DM")),
        getPollVoters: () => Promise.reject(new Error("unexpected poll")),
        getRecentMessages: () =>
          Promise.resolve([{
            id: "message",
            authorId: "human",
            authorName: "Alice",
            authorBot: false,
            content: "What a nice day!",
            timestamp: new Date(Date.now() - 1000).toISOString(),
            imageUrls: [],
          }]),
      },
      createStorageService(kv),
      new Intl.DateTimeFormat("en-US"),
      {
        generateReply() {
          aiCalls++;
          return Promise.resolve(result);
        },
      },
      rateLimit,
    );
    const run = jobs.get("Autonomous Chat");
    assert(run);
    await test({ run, rateLimit, aiCalls: () => aiCalls, posts });
  } finally {
    Deno.cron = originalCron;
    globalThis.fetch = originalFetch;
    kv.close();
  }
}

Deno.test("autonomous chat counts successful usage and blocks its next run at the soft budget", () =>
  withAutonomousJob({ ok: true, text: "Lovely day!", tokensUsed: 10 }, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    await fixture.run();
    assertEquals(fixture.aiCalls(), 1);
    assertEquals(fixture.posts, ["Lovely day!"]);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous chat records reported tokens on failure before checking the next run", () =>
  withAutonomousJob({ ok: false, error: "generation failed", tokensUsed: 10 }, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    await fixture.run();
    assertEquals(fixture.aiCalls(), 1);
    assertEquals(fixture.posts, []);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous chat preserves its exemption from the human per-minute limit", () =>
  withAutonomousJob({ ok: true, text: "Hello!", tokensUsed: 10 }, async (fixture) => {
    await fixture.run();
    await fixture.run();
    assertEquals(fixture.aiCalls(), 2);
    assertEquals(fixture.posts, ["Hello!", "Hello!"]);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 20,
      dailyTokenBudget: 100,
      requestsToday: 2,
    });
  }));

Deno.test("autonomous chat skips generation and request counting when budget is already exhausted", () =>
  withAutonomousJob({ ok: true, text: "Hello!", tokensUsed: 10 }, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(100);
    await fixture.run();
    assertEquals(fixture.aiCalls(), 0);
    assertEquals(fixture.posts, []);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 0);
  }));
