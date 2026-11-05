import { expect, test } from "bun:test";
import { asFetch } from "./test_support/fetch.ts";
import {
  bMessageMentionsBot,
  getBotUserId,
  getContext,
  handleMessage,
  postPoll,
  saveContext,
  sendMessage,
} from "./bot_actions.ts";
import type { AiResult } from "./ai_service.ts";
import type { BotDependencies } from "./bot_actions.ts";
import type { AppConfig } from "./src/config.ts";
import { createRateLimitService } from "./src/services/rate_limit.ts";
import { openDatabase } from "./src/db/database.ts";
import type { BudgetResult, RateLimitResult, UsageStats } from "./src/services/rate_limit.ts";
import type { LinkOpenError } from "./src/services/link_open.ts";
import type { SearchResult } from "./src/services/web_search.ts";
import { aszHaruGreetingGifPool } from "./src/features/reaction_gif.ts";
import type { ContextResetRecord } from "./src/types/storage.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "chan-1",
    channelIds: ["chan-1"],
    timeZone: "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: ["chan-1"],
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
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
  const bot_id = options.botId ?? "12345";
  const recent_messages = options.recentMessages ?? [];
  const me_status = options.meStatus ?? 200;
  const messages_status = options.messagesStatus ?? 200;
  const post_status = options.postStatus ?? 200;
  const posted_messages: string[] = [];
  const original_fetch = globalThis.fetch;

  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/users/@me")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: bot_id, username: "Haru" }), {
          status: me_status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages?limit=") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(recent_messages), {
          status: messages_status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages") && method === "POST") {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      posted_messages.push(String(body["content"] ?? ""));
      return Promise.resolve(
        new Response(JSON.stringify({ id: "posted-1" }), {
          status: post_status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  });

  return {
    postedMessages: posted_messages,
    restore: () => {
      globalThis.fetch = original_fetch;
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
    rateLimitResult?: RateLimitResult;
    budgetResult?: BudgetResult;
  } = {},
): {
  deps: BotDependencies;
  aiCalls: Array<Array<Record<string, unknown>>>;
  linkCalls: string[];
  webSearchCalls: string[];
  recordedTokens: number[];
  requestCount: number;
} {
  const ai_calls: Array<Array<Record<string, unknown>>> = [];
  const link_calls: string[] = [];
  const web_search_calls: string[] = [];
  const recorded_tokens: number[] = [];
  const context_resets = new Map<string, ContextResetRecord>();
  let request_count = 0;

  const deps: BotDependencies = {
    config,
    aiService: {
      generateReply(messages: Array<Record<string, unknown>>) {
        ai_calls.push(messages);
        return Promise.resolve(overrides.aiResult ?? { ok: true, text: "AI reply", tokensUsed: 9 });
      },
    },
    rateLimitService: {
      async admitRequest(userId) {
        const rate = await this.checkUserRateLimit(userId);
        if (!rate.allowed) return { ...rate, allowed: false, reason: "user_limit" };
        if (!(await this.checkDailyBudget()).allowed) {
          return { ...rate, allowed: false, reason: "daily_budget" };
        }
        await this.recordUserRequest(userId);
        return { ...rate, allowed: true };
      },
      checkUserRateLimit(_userId: string): Promise<RateLimitResult> {
        return Promise.resolve(
          overrides.rateLimitResult ?? {
            allowed: true,
            remaining: 99,
            resetInMs: 1000,
          },
        );
      },
      recordUserRequest(_userId: string): Promise<void> {
        request_count++;
        return Promise.resolve();
      },
      checkDailyBudget(): Promise<BudgetResult> {
        return Promise.resolve(
          overrides.budgetResult ?? { allowed: true, tokensRemaining: 999999 },
        );
      },
      recordTokenUsage(tokens: number): Promise<void> {
        recorded_tokens.push(tokens);
        return Promise.resolve();
      },
      getUsageStats(): Promise<UsageStats> {
        return Promise.resolve({
          dailyTokensUsed: recorded_tokens.reduce((a, b) => a + b, 0),
          dailyTokenBudget: config.aiDailyTokenBudget,
          requestsToday: request_count,
        });
      },
    },
    linkOpenService: {
      open(url: string) {
        link_calls.push(url);
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
        context_resets.set(record.channelId, record);
        return Promise.resolve();
      },
      getContextReset(channelId: string): Promise<ContextResetRecord | null> {
        return Promise.resolve(context_resets.get(channelId) ?? null);
      },
    },
    webSearchService: {
      search(query: string, _maxResults?: number) {
        web_search_calls.push(query);
        return Promise.resolve(
          overrides.webSearchResult ?? {
            ok: true,
            results: [{ title: "Deno", url: "https://deno.com", snippet: "A runtime" }],
          },
        );
      },
    },
  };

  return {
    deps,
    aiCalls: ai_calls,
    linkCalls: link_calls,
    webSearchCalls: web_search_calls,
    recordedTokens: recorded_tokens,
    get requestCount() {
      return request_count;
    },
  };
}

test("saveContext stores image attachment URLs in context", async () => {
  const channel_id = "channel-images-1";
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
    await saveContext(config, channel_id, 5);
    const ctx = getContext(channel_id) ?? [];

    expect(ctx.length).toStrictEqual(1);
    expect(ctx[0]["imageUrls"]).toStrictEqual([
      "https://cdn.discordapp.com/attachments/1/2/cat.png",
    ]);
  } finally {
    mock.restore();
  }
});

test("saveContext uses image filenames without trusting dimension-only hints", async () => {
  const channel_id = "channel-images-2";
  const config = createMockConfig();
  const mock = mockFetchMessages([
    {
      id: "m2",
      content: "",
      author: { id: "u2", username: "bob" },
      attachments: [
        {
          url: "https://media.discordapp.net/attachments/3/4/dog.jpg",
          filename: "dog.jpg",
        },
        {
          url: "https://cdn.discordapp.com/attachments/3/4/not-image.bin",
          filename: "not-image.bin",
          width: 1200,
          height: 800,
        },
      ],
      created_at: "2026-03-01T00:00:01.000Z",
    },
  ]);

  try {
    await saveContext(config, channel_id, 5);
    const ctx = getContext(channel_id) ?? [];

    expect(ctx.length).toStrictEqual(1);
    expect(ctx[0]["imageUrls"]).toStrictEqual([
      "https://media.discordapp.net/attachments/3/4/dog.jpg",
    ]);
  } finally {
    mock.restore();
  }
});

test("\\open command calls linkOpenService and injects web context", async () => {
  const fetch_mock = mockDiscordApiFetch({
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
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0]).toStrictEqual("AI reply");

    const ai_input = ctx.aiCalls[0];
    const web_entry = ai_input.find((m) => m["author"] === "web");
    expect(web_entry !== undefined).toStrictEqual(true);
    expect(String(web_entry?.["content"] ?? "")).toContain("Source domain: example.com");
    expect(String(web_entry?.["content"] ?? "")).toContain("Title: Example Title");
  } finally {
    fetch_mock.restore();
  }
});

test("\\open command includes optional user request in web context", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage(
      "<@12345> \\open https://example.com what are the key points?",
    );

    await handleMessage(message, ctx.deps);

    expect(ctx.aiCalls.length).toStrictEqual(1);
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    expect(String(web_entry?.["content"] ?? "")).toContain(
      "User request: what are the key points?",
    );
  } finally {
    fetch_mock.restore();
  }
});

test("\\open command with multiple urls uses first URL only", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage(
      "<@12345> \\open https://first.example/a https://second.example/b summarize this",
    );

    await handleMessage(message, ctx.deps);

    expect(ctx.linkCalls.length).toStrictEqual(1);
    expect(ctx.linkCalls[0]).toStrictEqual("https://first.example/a");
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    expect(String(web_entry?.["content"] ?? "").includes("https://second.example/b")).toStrictEqual(
      false,
    );
  } finally {
    fetch_mock.restore();
  }
});

test("\\open failure sends fallback message and skips AI", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      linkResult: { ok: false, error: "blocked_host" },
    });
    const message = createMentionMessage("<@12345> \\open http://127.0.0.1/private");

    await handleMessage(message, ctx.deps);

    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0]).toContain("couldn't safely open");
  } finally {
    fetch_mock.restore();
  }
});

test("non-open mention still uses auto-search flow", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: true });
    const ctx = createDeps(config, {
      webSearchResult: {
        ok: true,
        results: [{ title: "Deno Docs", url: "https://deno.com", snippet: "Runtime docs" }],
      },
    });
    const message = createMentionMessage("<@12345> what is deno?");

    await handleMessage(message, ctx.deps);

    expect(ctx.linkCalls.length).toStrictEqual(0);
    expect(ctx.webSearchCalls.length).toStrictEqual(1);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    expect(web_entry !== undefined).toStrictEqual(true);
    expect(String(web_entry?.["content"] ?? "")).toContain('Reference notes for "what is deno?"');
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage posts one greeting GIF when final reply has greeting trigger", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: false });
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "Ciallo! Hello there~", tokensUsed: 7 },
    });

    await handleMessage(createMentionMessage("<@12345> tell me something fun"), ctx.deps);

    expect(fetch_mock.postedMessages.length).toStrictEqual(2);
    expect(fetch_mock.postedMessages[0]).toStrictEqual("Ciallo! Hello there~");
    expect(aszHaruGreetingGifPool.includes(fetch_mock.postedMessages[1])).toStrictEqual(true);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage does not post greeting GIF when final reply has no greeting trigger", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: false });
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "I can help with that request.", tokensUsed: 7 },
    });

    await handleMessage(createMentionMessage("<@12345> tell me something fun"), ctx.deps);

    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0]).toStrictEqual("I can help with that request.");
  } finally {
    fetch_mock.restore();
  }
});

test("\\open replies strip URLs from final output", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "Check this out: https://evil.example/x wow!", tokensUsed: 5 },
    });
    const message = createMentionMessage("<@12345> \\open https://example.com");

    await handleMessage(message, ctx.deps);

    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0].includes("http")).toStrictEqual(false);
    expect(fetch_mock.postedMessages[0]).toContain("Check this out:");
  } finally {
    fetch_mock.restore();
  }
});

test("bMessageMentionsBot matches mention id, username, and fallback mention syntax", () => {
  expect(
    bMessageMentionsBot(undefined as unknown as Record<string, unknown>, "bot-0"),
  ).toStrictEqual(false);
  expect(bMessageMentionsBot({ mentions: [{ id: "bot-1" }] }, "bot-1")).toStrictEqual(true);
  expect(bMessageMentionsBot({ mentions: [{ username: "bot-2" }] }, "bot-2")).toStrictEqual(true);
  expect(bMessageMentionsBot({ content: "hello <@!bot-3>" }, "bot-3")).toStrictEqual(true);
  expect(bMessageMentionsBot({ mentions: [], content: "hello world" }, "bot-9")).toStrictEqual(
    false,
  );
});

test("sendMessage returns missing channel error", async () => {
  const result = await sendMessage(createMockConfig(), "", "hello");
  expect(result).toStrictEqual({ ok: false, error: "missing channelId" });
});

test("sendMessage returns discord error on non-ok response", async () => {
  const fetch_mock = mockDiscordApiFetch({ postStatus: 500 });
  try {
    const result = await sendMessage(createMockConfig(), "chan-1", "hello");
    expect(result.ok).toStrictEqual(false);
    if (!result.ok) {
      expect(result.error).toContain("Discord post error 500");
    }
  } finally {
    fetch_mock.restore();
  }
});

test("sendMessage returns fetch error when network fails", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.reject(new Error("network down"));
  });

  try {
    const result = await sendMessage(createMockConfig(), "chan-1", "hello");
    expect(result.ok).toStrictEqual(false);
    if (!result.ok) {
      expect(result.error).toContain("network down");
    }
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("postPoll handles success, error response, and thrown fetch", async () => {
  {
    const fetch_ok = mockDiscordApiFetch();
    try {
      await postPoll(createMockConfig(), "chan-1");
      expect(fetch_ok.postedMessages.length).toStrictEqual(1);
    } finally {
      fetch_ok.restore();
    }
  }

  {
    const fetch_error = mockDiscordApiFetch({ postStatus: 500 });
    try {
      await postPoll(createMockConfig(), "chan-1");
      expect(fetch_error.postedMessages.length).toStrictEqual(1);
    } finally {
      fetch_error.restore();
    }
  }

  {
    const original_fetch = globalThis.fetch;
    globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
      return Promise.reject(new Error("poll fetch failed"));
    });

    try {
      await postPoll(createMockConfig(), "chan-1");
    } finally {
      globalThis.fetch = original_fetch;
    }
  }
});

test("saveContext handles trigger inclusion, proxy_url image extraction, and trimming", async () => {
  const channel_id = "channel-savecontext-trim";
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
    await saveContext(config, channel_id, 2, {
      id: "m2",
      content: "trigger replacement",
      author: { id: "u2", username: "bob" },
      channel_id,
      timestamp: "2026-03-01T12:00:03.000Z",
    });
    const ctx = getContext(channel_id) ?? [];
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

test("saveContext excludes source messages without usable timestamps", async () => {
  const channel_id = "channel-no-timestamp";
  const mock = mockFetchMessages([
    {
      id: "m-no-ts",
      content: "hello",
      author: { id: "u1", username: "alice" },
    },
  ]);

  try {
    await saveContext(createMockConfig(), channel_id, 5);
    const ctx = getContext(channel_id) ?? [];
    expect(ctx).toStrictEqual([]);
  } finally {
    mock.restore();
  }
});

test("saveContext handles missing channel, non-ok fetch, and thrown fetch", async () => {
  const config = createMockConfig();

  await saveContext(config, "", 5);
  expect(getContext("")).toStrictEqual(undefined);

  {
    const fetch_mock = mockDiscordApiFetch({ messagesStatus: 500 });
    try {
      await saveContext(config, "channel-non-ok", 5);
      expect(getContext("channel-non-ok")).toStrictEqual(undefined);
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const original_fetch = globalThis.fetch;
    globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
      return Promise.reject(new Error("save context failed"));
    });
    try {
      await saveContext(config, "channel-throw", 5);
      expect(getContext("channel-throw")).toStrictEqual(undefined);
    } finally {
      globalThis.fetch = original_fetch;
    }
  }
});

test("handleMessage ignores non-mention and bot-authored messages", async () => {
  const fetch_mock = mockDiscordApiFetch();
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
    expect(fetch_mock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage exits early when message has no channel id", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ channelId: "" });
    const ctx = createDeps(config);
    const message = {
      id: "m-no-channel",
      content: "<@12345> hi",
      author: { id: "user-1", username: "alice", bot: false },
      mentions: [{ id: "12345" }],
    };

    await handleMessage(message, ctx.deps);

    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(fetch_mock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage exits when message payload is missing", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    await handleMessage(undefined as unknown as Record<string, unknown>, ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(fetch_mock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage persists reset and does not reload pre-reset Discord history", async () => {
  const config = createMockConfig({ webSearchEnabled: false });
  const preload_fetch = mockFetchMessages([
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
    preload_fetch.restore();
  }

  const fetch_mock = mockDiscordApiFetch({
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
    const reset_message = {
      ...createMentionMessage("<@12345> \\reset"),
      channel_id: "chan-reset",
    };
    await handleMessage(reset_message, ctx.deps);

    expect(getContext("chan-reset")).toStrictEqual(undefined);
    expect(await ctx.deps.storageService.getContextReset("chan-reset")).toStrictEqual({
      channelId: "chan-reset",
      messageId: "msg-trigger",
      resetAt: Date.parse("2026-03-01T12:00:00.000Z"),
    });
    expect(fetch_mock.postedMessages[0]).toContain("cleared our chat context");

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
    expect(fetch_mock.postedMessages.length).toStrictEqual(2);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage exits when AI is disabled", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ aiEnabled: false });
    const ctx = createDeps(config);
    await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(0);
    expect(ctx.requestCount).toStrictEqual(0);
    expect(fetch_mock.postedMessages.length).toStrictEqual(0);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage enforces rate limit and daily budget checks", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        rateLimitResult: { allowed: false, remaining: 0, resetInMs: 60000 },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.requestCount).toStrictEqual(0);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages[0]).toContain("1 minute");
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        budgetResult: { allowed: false, tokensRemaining: 0 },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.requestCount).toStrictEqual(0);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages[0]).toContain("brain power");
    } finally {
      fetch_mock.restore();
    }
  }
});

test("handleMessage formats short rate-limit windows in seconds", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      rateLimitResult: { allowed: false, remaining: 0, resetInMs: 1000 },
    });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0]).toContain("1 second");
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage supports missing author and missing webSearch service", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ webSearchEnabled: true });
    const ctx = createDeps(config);
    const deps_no_search: BotDependencies = {
      ...ctx.deps,
      webSearchService: undefined,
    };
    const message = {
      id: "m-unknown-author",
      channel_id: "chan-1",
      content: "<@12345> what is deno?",
      mentions: [{ id: "12345" }],
    };

    await handleMessage(message, deps_no_search);

    expect(ctx.webSearchCalls.length).toStrictEqual(0);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage handles mention with undefined content", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = {
      id: "m-empty-content",
      channel_id: "chan-1",
      author: { id: "user-1", username: "alice", bot: false },
      mentions: [{ id: "12345" }],
    };
    await handleMessage(message, ctx.deps);
    expect(ctx.aiCalls.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
  } finally {
    fetch_mock.restore();
  }
});

test("open command injects Untitled when fetched page has no title", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      linkResult: {
        ok: true,
        page: {
          domain: "example.com",
          title: "",
          excerpt: "body",
        },
      },
    });

    await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);

    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    expect(String(web_entry?.["content"] ?? "")).toContain("Title: Untitled");
  } finally {
    fetch_mock.restore();
  }
});

test("handleMessage handles open-command disabled and malformed cases", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig({ linkOpenEnabled: false });
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages[0]).toContain("turned off");
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> \\open not-a-url"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(0);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages[0]).toContain("put a link after \\open");
    } finally {
      fetch_mock.restore();
    }
  }
});

test("handleMessage handles search failure, AI failure, and reply post failure", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        webSearchResult: { ok: false, error: "search offline" },
      });
      await handleMessage(createMentionMessage("<@12345> what is deno?"), ctx.deps);
      expect(ctx.webSearchCalls.length).toStrictEqual(1);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        aiResult: { ok: false, error: "No text in OpenAI response" },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
      expect(fetch_mock.postedMessages[0]).toContain("brain's a bit fuzzy");
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const fetch_mock = mockDiscordApiFetch({ postStatus: 500 });
    try {
      const config = createMockConfig();
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      expect(ctx.aiCalls.length).toStrictEqual(1);
      expect(ctx.recordedTokens).toStrictEqual([9]);
      expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    } finally {
      fetch_mock.restore();
    }
  }
});

test("open command falls back to canned reply when URL stripping empties output", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "https://example.com/only-link", tokensUsed: 4 },
    });
    await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
    expect(fetch_mock.postedMessages.length).toStrictEqual(1);
    expect(fetch_mock.postedMessages[0]).toContain("I read it!");
  } finally {
    fetch_mock.restore();
  }
});

test("getBotUserId static import still returns a cached id", async () => {
  const fetch_mock = mockDiscordApiFetch({ botId: "12345" });
  try {
    const result = await getBotUserId(createMockConfig());
    expect(typeof result).toStrictEqual("string");
  } finally {
    fetch_mock.restore();
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
    rateLimitResult: { allowed: false, remaining: 0, resetInMs: 1000 },
    budgetResult: { allowed: false, tokensRemaining: 0 },
  });
  let reads = 0;
  state.deps.usageService = {
    getMonthToDate() {
      reads++;
      return Promise.resolve({
        start: "2026-10-01T00:00:00Z",
        asOf: "2026-10-06T00:00:00Z",
        openaiScope: "organization",
        awsCost: { ok: true, value: { amount: 1, currency: "USD" } },
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
    expect(mock.postedMessages[0]).toContain("**AWS cost:** $1.00");
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

test("usage handles unavailable service and unexpected service failures", async () => {
  const mock = mockDiscordApiFetch();
  const state = createDeps(createMockConfig());
  try {
    await handleMessage(createMentionMessage("<@12345> \\usage"), state.deps);
    state.deps.usageService = {
      getMonthToDate() {
        throw new Error("secret");
      },
    };
    await handleMessage(createMentionMessage("<@12345> \\usage"), state.deps);
    expect(mock.postedMessages).toStrictEqual([
      "Usage reporting is unavailable right now.",
      "Usage reporting is unavailable right now.",
    ]);
    expect(state.aiCalls.length).toStrictEqual(0);
  } finally {
    mock.restore();
  }
});
