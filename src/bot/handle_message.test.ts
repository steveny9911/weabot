import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { handleMessage } from "./handle_message.ts";
import { messageMentionsBot } from "./commands.ts";
import { getContext, saveContext } from "./context.ts";
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
import { testConfig } from "../../tests/support/config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    channelId: "chan-1",
    channelIds: ["chan-1"],
    timeZone: "America/Los_Angeles",
    aiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    autonomousChatChannelIds: ["chan-1"],
    ...overrides,
  });
}

function mockFetchMessages(messages: Array<Record<string, unknown>>): { restore: () => void } {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

interface DiscordFetchMock {
  postedMessages: string[];
  restore: () => void;
}

function mockDiscordApiFetch(
  options: {
    botId?: string;
    recentMessages?: Array<Record<string, unknown>>;
    meStatus?: number;
    messagesStatus?: number;
    postStatus?: number;
  } = {},
): DiscordFetchMock {
  const botId = options.botId ?? "12345";
  const recentMessages = options.recentMessages ?? [];
  const meStatus = options.meStatus ?? 200;
  const messagesStatus = options.messagesStatus ?? 200;
  const postStatus = options.postStatus ?? 200;
  const postedMessages: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/users/@me")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: botId, username: "Haru" }), {
          status: meStatus,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages?limit=") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(recentMessages), {
          status: messagesStatus,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages") && method === "POST") {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      postedMessages.push(String(body["content"] ?? ""));
      return Promise.resolve(
        new Response(JSON.stringify({ id: "posted-1" }), {
          status: postStatus,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  });

  return {
    postedMessages: postedMessages,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
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
  } = {},
): {
  deps: BotDependencies;
  aiCalls: Array<Array<Record<string, unknown>>>;
  linkCalls: string[];
  webSearchCalls: string[];
  recordedTokens: number[];
  requestCount: number;
} {
  const aiCalls: Array<Array<Record<string, unknown>>> = [];
  const linkCalls: string[] = [];
  const webSearchCalls: string[] = [];
  const recordedTokens: number[] = [];
  const contextResets = new Map<string, ContextResetRecord>();
  let requestCount = 0;

  const deps: BotDependencies = {
    config,
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
    get requestCount() {
      return requestCount;
    },
  };
}

test("saveContext stores image attachment URLs in context", async () => {
  const channelId = "channel-images-1";
  const config = createMockConfig();
  const mock = mockFetchMessages([
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
      created_at: "2026-03-01T00:00:00.000Z",
    },
  ]);

  try {
    await saveContext(config, channelId, 5);
    const ctx = getContext(channelId) ?? [];

    expect(ctx.length).toStrictEqual(1);
    expect(ctx[0]["imageUrls"]).toStrictEqual([
      "https://cdn.discordapp.com/attachments/1/2/cat.png",
    ]);
  } finally {
    mock.restore();
  }
});
test("\\open command calls linkOpenService and injects web context", async () => {
  const fetchMock = mockDiscordApiFetch({
    recentMessages: [
      {
        id: "old-1",
        content: "earlier chat",
        author: { id: "u2", username: "bob" },
        created_at: "2026-03-01T11:59:00.000Z",
      },
    ],
  });

  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage("<@12345> \\open https://example.com");

    await handleMessage(message, ctx.deps);

    expect(ctx.linkCalls).toStrictEqual(["https://example.com"]);
    expect(ctx.webSearchCalls.length).toStrictEqual(0);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(fetchMock.postedMessages.length).toStrictEqual(1);
    expect(fetchMock.postedMessages[0]).toStrictEqual("AI reply");

    const aiInput = ctx.aiCalls[0];
    const webEntry = aiInput.find((m) => m["author"] === "web");
    expect(webEntry !== undefined).toStrictEqual(true);
    expect(String(webEntry?.["content"] ?? "")).toContain("Source domain: example.com");
    expect(String(webEntry?.["content"] ?? "")).toContain("Title: Example Title");
  } finally {
    fetchMock.restore();
  }
});
test("\\open failure sends fallback message and skips AI", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      linkResult: { ok: false, error: "blocked_host" },
    });
    const message = createMentionMessage("<@12345> \\open http://127.0.0.1/private");

    await handleMessage(message, ctx.deps);

    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(fetchMock.postedMessages.length).toStrictEqual(1);
    expect(fetchMock.postedMessages[0]).toContain("couldn't safely open");
  } finally {
    fetchMock.restore();
  }
});

test("non-open mention still uses auto-search flow", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: true });
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
  } finally {
    fetchMock.restore();
  }
});

test("handleMessage posts one greeting GIF when final reply has greeting trigger", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: false });
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "Ciallo! Hello there~", tokensUsed: 7 },
    });

    await handleMessage(createMentionMessage("<@12345> tell me something fun"), ctx.deps);

    expect(fetchMock.postedMessages.length).toStrictEqual(2);
    expect(fetchMock.postedMessages[0]).toStrictEqual("Ciallo! Hello there~");
    expect(haruGreetingGifPool.includes(fetchMock.postedMessages[1])).toStrictEqual(true);
  } finally {
    fetchMock.restore();
  }
});
test("\\open replies strip URLs from final output", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "Check this out: https://evil.example/x wow!", tokensUsed: 5 },
    });
    const message = createMentionMessage("<@12345> \\open https://example.com");

    await handleMessage(message, ctx.deps);

    expect(fetchMock.postedMessages.length).toStrictEqual(1);
    expect(fetchMock.postedMessages[0].includes("http")).toStrictEqual(false);
    expect(fetchMock.postedMessages[0]).toContain("Check this out:");
  } finally {
    fetchMock.restore();
  }
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
test("saveContext handles trigger inclusion, proxy_url image extraction, and trimming", async () => {
  const channelId = "channel-savecontext-trim";
  const config = createMockConfig();
  const mock = mockFetchMessages([
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
      created_at: "2026-03-01T12:00:02.000Z",
    },
    {
      id: "m2",
      content: "middle",
      author: { id: "u2", username: "bob" },
      created_at: "2026-03-01T12:00:01.000Z",
    },
    {
      id: "m1",
      content: "oldest",
      author: { id: "u1", username: "alice" },
      created_at: "2026-03-01T12:00:00.000Z",
    },
  ]);

  try {
    await saveContext(config, channelId, 2, {
      id: "m2",
      content: "trigger replacement",
      author: { id: "u2", username: "bob" },
      channel_id: channelId,
      timestamp: "2026-03-01T12:00:03.000Z",
    });
    const ctx = getContext(channelId) ?? [];
    expect(ctx.length).toStrictEqual(2);
    expect(ctx[0]["id"]).toStrictEqual("m3");
    expect(ctx[1]["id"]).toStrictEqual("m2");
    expect(ctx[0]["author"]).toStrictEqual("u3");
    expect(ctx[0]["imageUrls"]).toStrictEqual([
      "https://media.discordapp.net/attachments/1/2/proxy.webp",
    ]);
    expect(ctx[0]["timestamp"]).toStrictEqual("2026-03-01T12:00:02.000Z");
  } finally {
    mock.restore();
  }
});
test("handleMessage ignores non-mention and bot-authored messages", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
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
    expect(fetchMock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetchMock.restore();
  }
});
test("handleMessage persists reset and does not reload pre-reset Discord history", async () => {
  const config = createMockConfig({ webSearchEnabled: false });
  const preloadFetch = mockFetchMessages([
    {
      id: "ctx-1",
      content: "cached line",
      author: { id: "u1", username: "alice" },
      created_at: "2026-03-01T11:00:00.000Z",
    },
  ]);

  try {
    await saveContext(config, "chan-reset", 5);
  } finally {
    preloadFetch.restore();
  }

  const fetchMock = mockDiscordApiFetch({
    recentMessages: [
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
  try {
    const ctx = createDeps(config);
    const resetMessage = {
      ...createMentionMessage("<@12345> \\reset"),
      channel_id: "chan-reset",
    };
    await handleMessage(resetMessage, ctx.deps);

    expect(getContext("chan-reset")).toStrictEqual(undefined);
    expect(await ctx.deps.storageService.getContextReset("chan-reset")).toStrictEqual({
      channelId: "chan-reset",
      messageId: "msg-trigger",
      resetAt: Date.parse("2026-03-01T12:00:00.000Z"),
    });
    expect(fetchMock.postedMessages[0]).toContain("cleared our chat context");

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
    expect(fetchMock.postedMessages.length).toStrictEqual(2);
  } finally {
    fetchMock.restore();
  }
});

test("handleMessage exits when AI is disabled", async () => {
  const fetchMock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ aiEnabled: false });
    const ctx = createDeps(config);
    await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.requestCount).toStrictEqual(0);
    expect(fetchMock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetchMock.restore();
  }
});

test("handleMessage enforces rate limit and daily budget checks", async () => {
  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        admission: { allowed: false, reason: "user_limit", remaining: 0, resetInMs: 60000 },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.requestCount).toStrictEqual(0);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
      expect(fetchMock.postedMessages[0]).toContain("1 minute");
    } finally {
      fetchMock.restore();
    }
  }

  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        admission: { allowed: false, reason: "daily_budget", remaining: 0, resetInMs: 0 },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.requestCount).toStrictEqual(0);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
      expect(fetchMock.postedMessages[0]).toContain("brain power");
    } finally {
      fetchMock.restore();
    }
  }
});
test("handleMessage handles open-command disabled and malformed cases", async () => {
  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig({ linkOpenEnabled: false });
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
      expect(fetchMock.postedMessages[0]).toContain("turned off");
    } finally {
      fetchMock.restore();
    }
  }

  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> \\open not-a-url"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
      expect(fetchMock.postedMessages[0]).toContain("put a link after \\open");
    } finally {
      fetchMock.restore();
    }
  }
});

test("handleMessage handles search failure, AI failure, and reply post failure", async () => {
  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        webSearchResult: { ok: false, error: "search offline" },
      });
      await handleMessage(createMentionMessage("<@12345> what is bun?"), ctx.deps);
      expect(ctx.webSearchCalls.length).toStrictEqual(1);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
    } finally {
      fetchMock.restore();
    }
  }

  {
    const fetchMock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        aiResult: { ok: false, error: "No text in OpenAI response" },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
      expect(fetchMock.postedMessages[0]).toContain("brain's a bit fuzzy");
    } finally {
      fetchMock.restore();
    }
  }

  {
    const fetchMock = mockDiscordApiFetch({ postStatus: 500 });
    try {
      const config = createMockConfig();
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(ctx.recordedTokens).toStrictEqual([9]);
      expect(fetchMock.postedMessages.length).toStrictEqual(1);
    } finally {
      fetchMock.restore();
    }
  }
});
test("handleMessage admits exactly one concurrent mention for one remaining allowance", async () => {
  const kv = openDatabase(":memory:");
  const fetchMock = mockDiscordApiFetch();
  try {
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
    expect(
      fetchMock.postedMessages.filter((message) => message.includes("speedy")).length,
    ).toStrictEqual(11);
    expect(
      fetchMock.postedMessages.filter((message) => message === "AI reply").length,
    ).toStrictEqual(1);
    expect(await fixture.deps.rateLimitService.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 9,
      dailyTokenBudget: config.aiDailyTokenBudget,
      requestsToday: 1,
    });
  } finally {
    fetchMock.restore();
    kv.close();
  }
});

test("usage command bypasses AI budgets and does not mutate conversation context", async () => {
  const mock = mockDiscordApiFetch();
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
  const context = getContext("chan-1");
  try {
    await handleMessage(createMentionMessage(" <@!12345> \\UsAgE "), state.deps);
    expect(reads).toStrictEqual(1);
    expect(state.aiCalls.length).toStrictEqual(0);
    expect(state.requestCount).toStrictEqual(0);
    expect(state.recordedTokens).toStrictEqual([]);
    expect(getContext("chan-1")).toStrictEqual(context);
    expect(mock.postedMessages[0]).toContain("**OpenAI API cost:** $2.00");
  } finally {
    mock.restore();
  }
});

test("usage requires a mention and configured channel and ignores bots", async () => {
  const mock = mockDiscordApiFetch();
  const state = createDeps(createMockConfig({ aiEnabled: false }));
  let reads = 0;
  state.deps.usageService = {
    getMonthToDate() {
      reads++;
      throw new Error("unexpected");
    },
  };
  try {
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
    expect(mock.postedMessages).toStrictEqual([
      "Usage is available in configured bot channels only.",
    ]);
  } finally {
    mock.restore();
  }
});
