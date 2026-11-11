import { expect, test } from "bun:test";
import { handleMessage } from "./handle_message.ts";
import { messageMentionsBot } from "./commands.ts";
import { loadContext } from "./context.ts";
import type { AiResult } from "../ai/types.ts";
import type { BotDependencies } from "./handle_message.ts";
import type { AppConfig } from "../config.ts";
import { createRateLimitService } from "../services/rate_limit.ts";
import { openDatabase } from "../db/database.ts";
import type { RequestAdmission, UsageStats } from "../services/rate_limit.ts";
import type { LinkOpenError } from "../net/link_open.ts";
import type { SearchResult } from "../net/web_search.ts";
import { haruGreetingGifPool } from "../features/reaction_gif.ts";
import type { ContextResetRecord } from "../types/storage.ts";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { fakeDiscord } from "../../tests/support/discord.ts";

function createMockConfig(overrides: ConfigOverrides = {}): AppConfig {
  return testConfig(
    {
      channelId: "chan-1",
      channelIds: ["chan-1"],
      timeZone: "America/Los_Angeles",
      aiApiKey: "sk-test-key",
      aiRateLimitPerUser: 2,
      aiDailyTokenBudget: 10000000,
      webSearch: { enabled: true, apiKey: "brave-key" },
      autonomousChat: { channelIds: ["chan-1"] },
    },
    overrides,
  );
}

function createMentionMessage(content: string, botId = "12345"): Record<string, unknown> {
  return {
    id: "msg-trigger",
    channel_id: "chan-1",
    content,
    author: { id: "user-1", username: "alice", bot: false },
    mentions: [{ id: botId, username: "Haru" }],
    timestamp: "2026-03-01T12:00:00.000Z",
  };
}

function createDeps(
  config: AppConfig,
  overrides: {
    aiResult?: AiResult;
    linkResult?:
      | { ok: true; page: { domain: string; title: string; excerpt: string } }
      | {
          ok: false;
          error: LinkOpenError;
        };
    webSearchResult?: { ok: true; results: SearchResult[] } | { ok: false; error: string };
    admission?: RequestAdmission;
    recent?: Array<Record<string, unknown>>;
    sendOk?: boolean;
  } = {},
): {
  deps: BotDependencies;
  aiCalls: Array<Array<Record<string, unknown>>>;
  linkCalls: string[];
  webSearchCalls: string[];
  recordedTokens: number[];
  requestCount: number;
  posted: string[];
} {
  const aiCalls: Array<Array<Record<string, unknown>>> = [];
  const linkCalls: string[] = [];
  const webSearchCalls: string[] = [];
  const recordedTokens: number[] = [];
  const contextResets = new Map<string, ContextResetRecord>();
  const posted: string[] = [];
  let requestCount = 0;

  const deps: BotDependencies = {
    config,
    discord: fakeDiscord({ sent: posted, recent: overrides.recent, sendOk: overrides.sendOk }),
    aiService: {
      generateReply(messages: Array<Record<string, unknown>>) {
        aiCalls.push(messages);
        return Promise.resolve(overrides.aiResult ?? { ok: true, text: "AI reply", tokensUsed: 9 });
      },
    },
    rateLimitService: {
      admitRequest() {
        const admission = overrides.admission ?? { allowed: true, remaining: 99, resetInMs: 1000 };
        if (admission.allowed) requestCount++;
        return Promise.resolve(admission);
      },
      recordModelCalls(calls = 1): Promise<void> {
        requestCount += calls - 1;
        return Promise.resolve();
      },
      recordTokenUsage(tokens: number): Promise<void> {
        recordedTokens.push(tokens);
        return Promise.resolve();
      },
      getUsageStats(): Promise<UsageStats> {
        return Promise.resolve({
          dailyTokensUsed: recordedTokens.reduce((a, b) => a + b, 0),
          dailyTokenBudget: config.aiDailyTokenBudget,
          requestsToday: requestCount,
        });
      },
    },
    linkOpenService: {
      open(url: string) {
        linkCalls.push(url);
        return Promise.resolve(
          overrides.linkResult ?? {
            ok: true,
            page: {
              domain: "example.com",
              title: "Example Title",
              excerpt: "Example page excerpt",
            },
          },
        );
      },
    },
    storageService: {
      setContextReset(record: ContextResetRecord): Promise<void> {
        contextResets.set(record.channelId, record);
        return Promise.resolve();
      },
      getContextReset(channelId: string): Promise<ContextResetRecord | null> {
        return Promise.resolve(contextResets.get(channelId) ?? null);
      },
    },
    webSearchService: {
      search(query: string, _maxResults?: number) {
        webSearchCalls.push(query);
        return Promise.resolve(
          overrides.webSearchResult ?? {
            ok: true,
            results: [{ title: "Bun", url: "https://bun.sh", snippet: "A runtime" }],
          },
        );
      },
    },
  };

  return {
    deps,
    aiCalls: aiCalls,
    linkCalls: linkCalls,
    webSearchCalls: webSearchCalls,
    recordedTokens: recordedTokens,
    posted: posted,
    get requestCount() {
      return requestCount;
    },
  };
}

test("loadContext stores image attachment URLs in context", async () => {
  const channelId = "channel-images-1";
  const config = createMockConfig();
  const trigger = {
    id: "m-trigger",
    content: "trigger",
    author: { id: "u-trigger", username: "alice" },
    timestamp: "2026-03-01T00:00:01.000Z",
  };
  const ctx = await loadContext(
    fakeDiscord({
      recent: [
        {
          id: "m1",
          content: "here is an image",
          author: { id: "u1", username: "alice" },
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
              content_type: "image/png",
              filename: "cat.png",
            },
            {
              url: "https://cdn.discordapp.com/attachments/1/2/readme.txt",
              content_type: "text/plain",
              filename: "readme.txt",
            },
          ],
          timestamp: "2026-03-01T00:00:00.000Z",
        },
      ],
    }),
    config,
    channelId,
    5,
    trigger,
  );

  expect(ctx.length).toStrictEqual(2);
  expect(ctx[0]["imageUrls"]).toStrictEqual(["https://cdn.discordapp.com/attachments/1/2/cat.png"]);
});
test("\\open command calls linkOpenService and injects web context", async () => {
  const config = createMockConfig();
  const ctx = createDeps(config, {
    recent: [
      {
        id: "old-1",
        content: "earlier chat",
        author: { id: "u2", username: "bob" },
        timestamp: "2026-03-01T11:59:00.000Z",
      },
    ],
  });
  const message = createMentionMessage("<@12345> \\open https://example.com");

  await handleMessage(message, ctx.deps);

  expect(ctx.linkCalls).toStrictEqual(["https://example.com"]);
  expect(ctx.webSearchCalls.length).toStrictEqual(0);
  expect(ctx.aiCalls.length).toStrictEqual(1);
  expect(ctx.posted.length).toStrictEqual(1);
  expect(ctx.posted[0]).toStrictEqual("AI reply");

  const aiInput = ctx.aiCalls[0];
  const webEntry = aiInput.find((m) => m["author"] === "web");
  expect(webEntry !== undefined).toStrictEqual(true);
  expect(String(webEntry?.["content"] ?? "")).toContain("Source domain: example.com");
  expect(String(webEntry?.["content"] ?? "")).toContain("Title: Example Title");
});
test("\\open failure sends fallback message and skips AI", async () => {
  const config = createMockConfig();
  const ctx = createDeps(config, {
    linkResult: { ok: false, error: "blocked_host" },
  });
  const message = createMentionMessage("<@12345> \\open http://127.0.0.1/private");

  await handleMessage(message, ctx.deps);

  expect(ctx.aiCalls.length).toStrictEqual(0);
  expect(ctx.posted.length).toStrictEqual(1);
  expect(ctx.posted[0]).toContain("couldn't safely open");
});

const tweetMention = "<@12345> what do you think? https://x.com/kay/status/123";

test("tweet link adds the tweet text and photos to the AI context", async () => {
  const ctx = createDeps(createMockConfig({ webSearch: { enabled: true } }));
  const photoUrls = ["https://pbs.twimg.com/a.jpg"];
  ctx.deps.tweetService = {
    read: () =>
      Promise.resolve({
        ok: true,
        tweet: { author: "kay", text: "a cat", photoUrls, altTexts: [], hasVideo: true },
      }),
  };

  await handleMessage(createMentionMessage(tweetMention), ctx.deps);

  const webEntry = ctx.aiCalls[0].find((m) => m["author"] === "web");
  expect(String(webEntry?.["content"])).toContain("Text: a cat");
  expect(String(webEntry?.["content"])).toContain("video (not viewed)");
  expect(webEntry?.["imageUrls"]).toStrictEqual(photoUrls);
  expect(ctx.webSearchCalls.length).toStrictEqual(0);
});

test("unreadable tweet sends a fallback message and skips AI", async () => {
  const ctx = createDeps(createMockConfig());
  ctx.deps.tweetService = { read: () => Promise.resolve({ ok: false, error: "not_found" }) };

  await handleMessage(createMentionMessage(tweetMention), ctx.deps);

  expect(ctx.aiCalls.length).toStrictEqual(0);
  expect(ctx.posted[0]).toContain("couldn't read that tweet");
});

test("tweet links are plain text when tweet reading is off", async () => {
  const ctx = createDeps(createMockConfig({ tweetRead: { enabled: false } }));
  ctx.deps.tweetService = { read: () => Promise.reject(new Error("should not be called")) };

  await handleMessage(createMentionMessage(tweetMention), ctx.deps);

  expect(ctx.aiCalls.length).toStrictEqual(1);
});

test("non-open mention still uses auto-search flow", async () => {
  const config = createMockConfig({ webSearch: { enabled: true } });
  const ctx = createDeps(config, {
    webSearchResult: {
      ok: true,
      results: [{ title: "Bun Docs", url: "https://bun.sh", snippet: "Runtime docs" }],
    },
  });
  const message = createMentionMessage("<@12345> what is bun?");

  await handleMessage(message, ctx.deps);

  expect(ctx.linkCalls.length).toStrictEqual(0);
  expect(ctx.webSearchCalls.length).toStrictEqual(1);
  expect(ctx.aiCalls.length).toStrictEqual(1);
  const webEntry = ctx.aiCalls[0].find((m) => m["author"] === "web");
  expect(webEntry !== undefined).toStrictEqual(true);
  expect(String(webEntry?.["content"] ?? "")).toContain('Reference notes for "what is bun?"');
});

test("handleMessage posts one greeting GIF when final reply has greeting trigger", async () => {
  const config = createMockConfig({ webSearch: { enabled: false } });
  const ctx = createDeps(config, {
    aiResult: { ok: true, text: "Ciallo! Hello there~", tokensUsed: 7 },
  });

  await handleMessage(createMentionMessage("<@12345> tell me something fun"), ctx.deps);

  expect(ctx.posted.length).toStrictEqual(2);
  expect(ctx.posted[0]).toStrictEqual("Ciallo! Hello there~");
  expect(haruGreetingGifPool.includes(ctx.posted[1])).toStrictEqual(true);
});
test("\\open replies strip URLs from final output", async () => {
  const config = createMockConfig();
  const ctx = createDeps(config, {
    aiResult: { ok: true, text: "Check this out: https://evil.example/x wow!", tokensUsed: 5 },
  });
  const message = createMentionMessage("<@12345> \\open https://example.com");

  await handleMessage(message, ctx.deps);

  expect(ctx.posted.length).toStrictEqual(1);
  expect(ctx.posted[0].includes("http")).toStrictEqual(false);
  expect(ctx.posted[0]).toContain("Check this out:");
});

test("messageMentionsBot matches mention id, username, and fallback mention syntax", () => {
  expect(
    messageMentionsBot(undefined as unknown as Record<string, unknown>, "bot-0"),
  ).toStrictEqual(false);
  expect(messageMentionsBot({ mentions: [{ id: "bot-1" }] }, "bot-1")).toStrictEqual(true);
  expect(messageMentionsBot({ mentions: [{ username: "bot-2" }] }, "bot-2")).toStrictEqual(true);
  expect(messageMentionsBot({ content: "hello <@!bot-3>" }, "bot-3")).toStrictEqual(true);
  expect(messageMentionsBot({ mentions: [], content: "hello world" }, "bot-9")).toStrictEqual(
    false,
  );
});
test("loadContext handles trigger inclusion, proxy_url image extraction, and trimming", async () => {
  const channelId = "channel-savecontext-trim";
  const config = createMockConfig();
  const trigger = {
    id: "m2",
    content: "trigger replacement",
    author: { id: "u2", username: "bob" },
    channel_id: channelId,
    timestamp: "2026-03-01T12:00:03.000Z",
  };
  const ctx = await loadContext(
    fakeDiscord({
      recent: [
        {
          id: "m3",
          content: "newest",
          author: { id: "u3" },
          attachments: [
            null,
            {
              content_type: "image/png",
              filename: "missing-url.png",
            },
            {
              url: "not-a-url",
              content_type: "image/png",
            },
            {
              proxy_url: "https://media.discordapp.net/attachments/1/2/proxy.webp",
              width: 100,
              height: 100,
            },
            {
              url: "ftp://bad.example/file.png",
              content_type: "image/png",
            },
          ],
          timestamp: "2026-03-01T12:00:02.000Z",
        },
        {
          id: "m2",
          content: "middle",
          author: { id: "u2", username: "bob" },
          timestamp: "2026-03-01T12:00:01.000Z",
        },
        {
          id: "m1",
          content: "oldest",
          author: { id: "u1", username: "alice" },
          timestamp: "2026-03-01T12:00:00.000Z",
        },
      ],
    }),
    config,
    channelId,
    2,
    trigger,
  );
  expect(ctx.length).toStrictEqual(2);
  expect(ctx[0]["id"]).toStrictEqual("m3");
  expect(ctx[1]["id"]).toStrictEqual("m2");
  expect(ctx[0]["author"]).toStrictEqual("u3");
  expect(ctx[0]["imageUrls"]).toStrictEqual([
    "https://media.discordapp.net/attachments/1/2/proxy.webp",
  ]);
  expect(ctx[0]["timestamp"]).toStrictEqual("2026-03-01T12:00:02.000Z");
});
test("handleMessage ignores non-mention and bot-authored messages", async () => {
  const config = createMockConfig();
  const ctx = createDeps(config);

  const notMention = {
    id: "m-no-mention",
    channel_id: "chan-1",
    content: "hello",
    author: { id: "user-1", username: "alice", bot: false },
    mentions: [],
  };
  await handleMessage(notMention, ctx.deps);

  const fromBot = {
    id: "m-from-bot",
    channel_id: "chan-1",
    content: "<@12345> hi",
    author: { id: "user-2", username: "otherbot", bot: true },
    mentions: [{ id: "12345" }],
  };
  await handleMessage(fromBot, ctx.deps);

  const fromSelf = {
    id: "m-from-self",
    channel_id: "chan-1",
    content: "<@12345> hi",
    author: { id: "12345", username: "Haru", bot: false },
    mentions: [{ id: "12345" }],
  };
  await handleMessage(fromSelf, ctx.deps);

  expect(ctx.aiCalls.length).toStrictEqual(0);
  expect(ctx.posted.length).toStrictEqual(0);
});
test("handleMessage persists reset and does not reload pre-reset Discord history", async () => {
  const config = createMockConfig({ webSearch: { enabled: false } });

  const ctx = createDeps(config, {
    recent: [
      {
        id: "msg-after-reset",
        content: "<@12345> what do you remember?",
        author: { id: "user-1", username: "alice", bot: false },
        timestamp: "2026-03-01T12:01:00.000Z",
      },
      {
        id: "msg-trigger",
        content: "<@12345> \\reset",
        author: { id: "user-1", username: "alice", bot: false },
        timestamp: "2026-03-01T12:00:00.000Z",
      },
      {
        id: "old-before-reset",
        content: "this must stay forgotten",
        author: { id: "user-2", username: "bob", bot: false },
        timestamp: "2026-03-01T11:59:00.000Z",
      },
    ],
  });
  const resetMessage = {
    ...createMentionMessage("<@12345> \\reset"),
    channel_id: "chan-reset",
  };
  await handleMessage(resetMessage, ctx.deps);

  expect(await ctx.deps.storageService.getContextReset("chan-reset")).toStrictEqual({
    channelId: "chan-reset",
    messageId: "msg-trigger",
    resetAt: Date.parse("2026-03-01T12:00:00.000Z"),
  });
  expect(ctx.posted[0]).toContain("cleared our chat context");

  await handleMessage(
    {
      ...createMentionMessage("<@12345> what do you remember?"),
      id: "msg-after-reset",
      channel_id: "chan-reset",
      timestamp: "2026-03-01T12:01:00.000Z",
    },
    ctx.deps,
  );

  expect(ctx.aiCalls.length).toStrictEqual(1);
  expect(ctx.aiCalls[0].map((entry) => entry["id"])).toStrictEqual(["msg-after-reset"]);
  expect(ctx.posted.length).toStrictEqual(2);
});

test("handleMessage exits when AI is disabled", async () => {
  const config = createMockConfig({ aiEnabled: false });
  const ctx = createDeps(config);
  await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
  expect(ctx.aiCalls.length).toStrictEqual(0);
  expect(ctx.requestCount).toStrictEqual(0);
  expect(ctx.posted.length).toStrictEqual(0);
});

test("handleMessage enforces rate limit and daily budget checks", async () => {
  {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      admission: { allowed: false, reason: "user_limit", remaining: 0, resetInMs: 60000 },
    });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    expect(ctx.requestCount).toStrictEqual(0);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.posted.length).toStrictEqual(1);
    expect(ctx.posted[0]).toContain("1 minute");
  }

  {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      admission: { allowed: false, reason: "daily_budget", remaining: 0, resetInMs: 0 },
    });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    expect(ctx.requestCount).toStrictEqual(0);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.posted.length).toStrictEqual(1);
    expect(ctx.posted[0]).toContain("brain power");
  }
});
test("handleMessage handles open-command disabled and malformed cases", async () => {
  {
    const config = createMockConfig({ linkOpen: { enabled: false } });
    const ctx = createDeps(config);
    await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.posted.length).toStrictEqual(1);
    expect(ctx.posted[0]).toContain("turned off");
  }

  {
    const config = createMockConfig();
    const ctx = createDeps(config);
    await handleMessage(createMentionMessage("<@12345> \\open not-a-url"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.posted.length).toStrictEqual(1);
    expect(ctx.posted[0]).toContain("put a link after \\open");
  }
});

test("handleMessage handles search failure, AI failure, and reply post failure", async () => {
  {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      webSearchResult: { ok: false, error: "search offline" },
    });
    await handleMessage(createMentionMessage("<@12345> what is bun?"), ctx.deps);
    expect(ctx.webSearchCalls.length).toStrictEqual(1);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(ctx.posted.length).toStrictEqual(1);
  }

  {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: false, error: "No text in OpenAI response" },
    });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(ctx.posted.length).toStrictEqual(1);
    expect(ctx.posted[0]).toContain("brain's a bit fuzzy");
  }

  {
    const config = createMockConfig();
    const ctx = createDeps(config, { sendOk: false });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(ctx.recordedTokens).toStrictEqual([9]);
    expect(ctx.posted.length).toStrictEqual(1);
  }
});
test("handleMessage admits exactly one concurrent mention for one remaining allowance", async () => {
  const kv = openDatabase(":memory:");
  const config = createMockConfig({ aiRateLimitPerUser: 1 });
  const fixture = createDeps(config);
  fixture.deps.rateLimitService = createRateLimitService(kv, config, () =>
    Date.parse("2026-09-05T12:34:00Z"),
  );
  await Promise.all(
    Array.from({ length: 12 }, () =>
      handleMessage(createMentionMessage("<@12345> hello"), fixture.deps),
    ),
  );
  expect(fixture.aiCalls.length).toStrictEqual(1);
  expect(fixture.posted.filter((message) => message.includes("speedy")).length).toStrictEqual(11);
  expect(fixture.posted.filter((message) => message === "AI reply").length).toStrictEqual(1);
  expect(await fixture.deps.rateLimitService.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 9,
    dailyTokenBudget: config.aiDailyTokenBudget,
    requestsToday: 1,
  });
  kv.close();
});

test("usage command bypasses AI budgets and does not mutate conversation context", async () => {
  const state = createDeps(createMockConfig({ aiEnabled: false }), {
    admission: { allowed: false, reason: "daily_budget", remaining: 0, resetInMs: 0 },
  });
  let reads = 0;
  state.deps.usageService = {
    getMonthToDate() {
      reads++;
      return Promise.resolve({
        start: "2026-10-01T00:00:00Z",
        asOf: "2026-10-06T00:00:00Z",
        openaiScope: "organization",
        openaiCost: { ok: true, value: { amount: 2, currency: "USD" } },
        tokens: { ok: true, value: { input: 100, cached: 20, output: 10 } },
      });
    },
  };
  await handleMessage(createMentionMessage(" <@!12345> \\UsAgE "), state.deps);
  expect(reads).toStrictEqual(1);
  expect(state.aiCalls.length).toStrictEqual(0);
  expect(state.requestCount).toStrictEqual(0);
  expect(state.recordedTokens).toStrictEqual([]);
  expect(state.posted[0]).toContain("**OpenAI API cost:** $2.00");
});

test("usage shows Haru's own daily counts when the provider has no billing report", async () => {
  const state = createDeps(
    createMockConfig({ aiProvider: "gemini", aiDailyRequestQuota: 100, aiDailyRequestPercent: 90 }),
  );
  state.deps.usageService = {
    getMonthToDate() {
      throw new Error("unexpected");
    },
  };
  await handleMessage(createMentionMessage("<@12345> \\usage"), state.deps);
  expect(state.posted[0]).toContain("**Requests:** 0 / 90");
  expect(state.posted[0]).toContain("**Tokens:** 0");
});

test("usage requires a mention and configured channel and ignores bots", async () => {
  const state = createDeps(createMockConfig({ aiEnabled: false }));
  let reads = 0;
  state.deps.usageService = {
    getMonthToDate() {
      reads++;
      throw new Error("unexpected");
    },
  };
  await handleMessage({ ...createMentionMessage("\\usage"), mentions: [] }, state.deps);
  await handleMessage(
    { ...createMentionMessage("<@12345> \\usage"), author: { bot: true } },
    state.deps,
  );
  await handleMessage(
    { ...createMentionMessage("<@12345> \\usage"), channel_id: "other" },
    state.deps,
  );
  await handleMessage(createMentionMessage("<@12345> \\usage-extra"), state.deps);
  await handleMessage(createMentionMessage("<@12345> discuss \\usage"), state.deps);
  expect(reads).toStrictEqual(0);
  expect(state.posted).toStrictEqual(["Usage is available in configured bot channels only."]);
});

test("landmines are rolled for every message, mention or not", async () => {
  const config = createMockConfig();
  const { deps } = createDeps(config);
  const stepped: Array<Record<string, unknown>> = [];
  deps.landmineService = {
    step(message) {
      stepped.push(message);
      return Promise.resolve();
    },
  };
  const plain = { ...createMentionMessage("just chatting"), mentions: [] };
  await handleMessage(plain, deps);
  expect(stepped).toStrictEqual([plain]);
});

test("landmines are not rolled for bot messages", async () => {
  const config = createMockConfig();
  const { deps } = createDeps(config);
  let stepped = 0;
  deps.landmineService = {
    step() {
      stepped++;
      return Promise.resolve();
    },
  };
  const fromBot = {
    ...createMentionMessage("beep"),
    mentions: [],
    author: { id: "bot-1", bot: true },
  };
  await handleMessage(fromBot, deps);
  expect(stepped).toBe(0);
});

test("link open, tweet reading and web search follow their own channels", async () => {
  const elsewhere = { channelIds: ["elsewhere"] };
  const ctx = createDeps(
    createMockConfig({
      linkOpen: elsewhere,
      tweetRead: elsewhere,
      webSearch: { enabled: true, ...elsewhere },
    }),
  );
  ctx.deps.tweetService = { read: () => Promise.reject(new Error("should not be called")) };

  await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
  expect(ctx.linkCalls.length).toStrictEqual(0);
  expect(ctx.posted[0]).toContain("turned off");

  await handleMessage(createMentionMessage(tweetMention), ctx.deps);
  await handleMessage(createMentionMessage("<@12345> what is bun?"), ctx.deps);
  expect(ctx.webSearchCalls.length).toStrictEqual(0);
  expect(ctx.aiCalls.length).toStrictEqual(2);
});

test("mentions get no reply where AI chat is off, but \\reset still answers", async () => {
  for (const aiChat of [{ enabled: false }, { channelIds: ["elsewhere"] }]) {
    const ctx = createDeps(createMockConfig({ aiChat }));
    await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.posted).toStrictEqual([]);

    await handleMessage(createMentionMessage("<@12345> \\reset"), ctx.deps);
    expect(ctx.posted.length).toStrictEqual(1);
  }
});

test("ai.enabled is the master switch: no reply even where AI chat is on", async () => {
  const ctx = createDeps(createMockConfig({ aiEnabled: false, aiChat: { enabled: true } }));
  await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
  expect(ctx.aiCalls.length).toStrictEqual(0);
});
