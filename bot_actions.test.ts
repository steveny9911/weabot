import { assertEquals, assertStringIncludes } from "@std/assert";
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
import type { BudgetResult, RateLimitResult, UsageStats } from "./src/services/rate_limit.ts";
import type { LinkOpenError } from "./src/services/link_open.ts";
import type { SearchResult } from "./src/services/web_search.ts";

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
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    ...overrides,
  };
}

function mockFetchMessages(
  messages: Array<Record<string, unknown>>,
): { restore: () => void } {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

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

function mockDiscordApiFetch(options: {
  botId?: string;
  recentMessages?: Array<Record<string, unknown>>;
  meStatus?: number;
  messagesStatus?: number;
  postStatus?: number;
} = {}): DiscordFetchMock {
  const bot_id = options.botId ?? "12345";
  const recent_messages = options.recentMessages ?? [];
  const me_status = options.meStatus ?? 200;
  const messages_status = options.messagesStatus ?? 200;
  const post_status = options.postStatus ?? 200;
  const posted_messages: string[] = [];
  const original_fetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
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
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      posted_messages.push(String(body["content"] ?? ""));
      return Promise.resolve(
        new Response(JSON.stringify({ id: "posted-1" }), {
          status: post_status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

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
    linkResult?: { ok: true; page: { domain: string; title: string; excerpt: string } } | {
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
      checkUserRateLimit(_userId: string): Promise<RateLimitResult> {
        return Promise.resolve(overrides.rateLimitResult ?? {
          allowed: true,
          remaining: 99,
          resetInMs: 1000,
        });
      },
      recordUserRequest(_userId: string): Promise<void> {
        request_count++;
        return Promise.resolve();
      },
      checkDailyBudget(): Promise<BudgetResult> {
        return Promise.resolve(overrides.budgetResult ?? { allowed: true, tokensRemaining: 999999 });
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
        return Promise.resolve(overrides.linkResult ?? {
          ok: true,
          page: {
            domain: "example.com",
            title: "Example Title",
            excerpt: "Example page excerpt",
          },
        });
      },
    },
    webSearchService: {
      search(query: string, _maxResults?: number) {
        web_search_calls.push(query);
        return Promise.resolve(overrides.webSearchResult ?? {
          ok: true,
          results: [{ title: "Deno", url: "https://deno.com", snippet: "A runtime" }],
        });
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

Deno.test("saveContext stores image attachment URLs in context", async () => {
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

    assertEquals(ctx.length, 1);
    assertEquals(ctx[0]["imageUrls"], ["https://cdn.discordapp.com/attachments/1/2/cat.png"]);
  } finally {
    mock.restore();
  }
});

Deno.test("saveContext treats image by filename/size hints even without content_type", async () => {
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

    assertEquals(ctx.length, 1);
    assertEquals(ctx[0]["imageUrls"], [
      "https://media.discordapp.net/attachments/3/4/dog.jpg",
      "https://cdn.discordapp.com/attachments/3/4/not-image.bin",
    ]);
  } finally {
    mock.restore();
  }
});

Deno.test("\\open command calls linkOpenService and injects web context", async () => {
  const fetch_mock = mockDiscordApiFetch({
    recentMessages: [{
      id: "old-1",
      content: "earlier chat",
      author: { id: "u2", username: "bob" },
      created_at: "2026-03-01T11:59:00.000Z",
    }],
  });

  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage("<@12345> \\open https://example.com");

    await handleMessage(message, ctx.deps);

    assertEquals(ctx.linkCalls, ["https://example.com"]);
    assertEquals(ctx.webSearchCalls.length, 0);
    assertEquals(ctx.aiCalls.length, 1);
    assertEquals(fetch_mock.postedMessages.length, 1);
    assertEquals(fetch_mock.postedMessages[0], "AI reply");

    const ai_input = ctx.aiCalls[0];
    const web_entry = ai_input.find((m) => m["author"] === "web");
    assertEquals(web_entry !== undefined, true);
    assertStringIncludes(String(web_entry?.["content"] ?? ""), "Source domain: example.com");
    assertStringIncludes(String(web_entry?.["content"] ?? ""), "Title: Example Title");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("\\open command includes optional user request in web context", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage(
      "<@12345> \\open https://example.com what are the key points?",
    );

    await handleMessage(message, ctx.deps);

    assertEquals(ctx.aiCalls.length, 1);
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    assertStringIncludes(
      String(web_entry?.["content"] ?? ""),
      "User request: what are the key points?",
    );
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("\\open command with multiple urls uses first URL only", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    const message = createMentionMessage(
      "<@12345> \\open https://first.example/a https://second.example/b summarize this",
    );

    await handleMessage(message, ctx.deps);

    assertEquals(ctx.linkCalls.length, 1);
    assertEquals(ctx.linkCalls[0], "https://first.example/a");
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    assertEquals(String(web_entry?.["content"] ?? "").includes("https://second.example/b"), false);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("\\open failure sends fallback message and skips AI", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      linkResult: { ok: false, error: "blocked_host" },
    });
    const message = createMentionMessage("<@12345> \\open http://127.0.0.1/private");

    await handleMessage(message, ctx.deps);

    assertEquals(ctx.aiCalls.length, 0);
    assertEquals(fetch_mock.postedMessages.length, 1);
    assertStringIncludes(fetch_mock.postedMessages[0], "couldn't safely open");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("non-open mention still uses auto-search flow", async () => {
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

    assertEquals(ctx.linkCalls.length, 0);
    assertEquals(ctx.webSearchCalls.length, 1);
    assertEquals(ctx.aiCalls.length, 1);
    const web_entry = ctx.aiCalls[0].find((m) => m["author"] === "web");
    assertEquals(web_entry !== undefined, true);
    assertStringIncludes(
      String(web_entry?.["content"] ?? ""),
      'Reference notes for "what is deno?"',
    );
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("\\open replies strip URLs from final output", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "Check this out: https://evil.example/x wow!", tokensUsed: 5 },
    });
    const message = createMentionMessage("<@12345> \\open https://example.com");

    await handleMessage(message, ctx.deps);

    assertEquals(fetch_mock.postedMessages.length, 1);
    assertEquals(fetch_mock.postedMessages[0].includes("http"), false);
    assertStringIncludes(fetch_mock.postedMessages[0], "Check this out:");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("bMessageMentionsBot matches mention id, username, and fallback mention syntax", () => {
  assertEquals(
    bMessageMentionsBot(undefined as unknown as Record<string, unknown>, "bot-0"),
    false,
  );
  assertEquals(
    bMessageMentionsBot({ mentions: [{ id: "bot-1" }] }, "bot-1"),
    true,
  );
  assertEquals(
    bMessageMentionsBot({ mentions: [{ username: "bot-2" }] }, "bot-2"),
    true,
  );
  assertEquals(
    bMessageMentionsBot({ content: "hello <@!bot-3>" }, "bot-3"),
    true,
  );
  assertEquals(
    bMessageMentionsBot({ mentions: [], content: "hello world" }, "bot-9"),
    false,
  );
});

Deno.test("sendMessage returns missing channel error", async () => {
  const result = await sendMessage(createMockConfig(), "", "hello");
  assertEquals(result, { ok: false, error: "missing channelId" });
});

Deno.test("sendMessage returns discord error on non-ok response", async () => {
  const fetch_mock = mockDiscordApiFetch({ postStatus: 500 });
  try {
    const result = await sendMessage(createMockConfig(), "chan-1", "hello");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "Discord post error 500");
    }
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("sendMessage returns fetch error when network fails", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.reject(new Error("network down"));
  }) as typeof fetch;

  try {
    const result = await sendMessage(createMockConfig(), "chan-1", "hello");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "network down");
    }
  } finally {
    globalThis.fetch = original_fetch;
  }
});

Deno.test("postPoll handles success, error response, and thrown fetch", async () => {
  {
    const fetch_ok = mockDiscordApiFetch();
    try {
      await postPoll(createMockConfig(), "chan-1");
      assertEquals(fetch_ok.postedMessages.length, 1);
    } finally {
      fetch_ok.restore();
    }
  }

  {
    const fetch_error = mockDiscordApiFetch({ postStatus: 500 });
    try {
      await postPoll(createMockConfig(), "chan-1");
      assertEquals(fetch_error.postedMessages.length, 1);
    } finally {
      fetch_error.restore();
    }
  }

  {
    const original_fetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      return Promise.reject(new Error("poll fetch failed"));
    }) as typeof fetch;

    try {
      await postPoll(createMockConfig(), "chan-1");
    } finally {
      globalThis.fetch = original_fetch;
    }
  }
});

Deno.test("saveContext handles trigger inclusion, proxy_url image extraction, and trimming", async () => {
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
    assertEquals(ctx.length, 2);
    assertEquals(ctx[0]["id"], "m3");
    assertEquals(ctx[1]["id"], "m2");
    assertEquals(ctx[0]["author"], "u3");
    assertEquals(ctx[0]["imageUrls"], ["https://media.discordapp.net/attachments/1/2/proxy.webp"]);
    assertEquals(ctx[0]["timestamp"], "2026-03-01T12:00:02.000Z");
  } finally {
    mock.restore();
  }
});

Deno.test("saveContext sets null timestamp when source message has no timestamp fields", async () => {
  const channel_id = "channel-no-timestamp";
  const mock = mockFetchMessages([{
    id: "m-no-ts",
    content: "hello",
    author: { id: "u1", username: "alice" },
  }]);

  try {
    await saveContext(createMockConfig(), channel_id, 5);
    const ctx = getContext(channel_id) ?? [];
    assertEquals(ctx.length, 1);
    assertEquals(ctx[0]["timestamp"], null);
  } finally {
    mock.restore();
  }
});

Deno.test("saveContext handles missing channel, non-ok fetch, and thrown fetch", async () => {
  const config = createMockConfig();

  await saveContext(config, "", 5);
  assertEquals(getContext(""), undefined);

  {
    const fetch_mock = mockDiscordApiFetch({ messagesStatus: 500 });
    try {
      await saveContext(config, "channel-non-ok", 5);
      assertEquals(getContext("channel-non-ok"), undefined);
    } finally {
      fetch_mock.restore();
    }
  }

  {
    const original_fetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      return Promise.reject(new Error("save context failed"));
    }) as typeof fetch;
    try {
      await saveContext(config, "channel-throw", 5);
      assertEquals(getContext("channel-throw"), undefined);
    } finally {
      globalThis.fetch = original_fetch;
    }
  }
});

Deno.test("handleMessage ignores non-mention and bot-authored messages", async () => {
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

    assertEquals(ctx.aiCalls.length, 0);
    assertEquals(fetch_mock.postedMessages.length, 0);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage exits early when message has no channel id", async () => {
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

    assertEquals(ctx.aiCalls.length, 0);
    assertEquals(fetch_mock.postedMessages.length, 0);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage exits when message payload is missing", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config);
    await handleMessage(undefined as unknown as Record<string, unknown>, ctx.deps);
    assertEquals(ctx.aiCalls.length, 0);
    assertEquals(fetch_mock.postedMessages.length, 0);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage handles reset command and clears cached context", async () => {
  const config = createMockConfig();
  const preload_fetch = mockFetchMessages([{
    id: "ctx-1",
    content: "cached line",
    author: { id: "u1", username: "alice" },
    created_at: "2026-03-01T11:00:00.000Z",
  }]);

  try {
    await saveContext(config, "chan-reset", 5);
  } finally {
    preload_fetch.restore();
  }

  const fetch_mock = mockDiscordApiFetch();
  try {
    const ctx = createDeps(config);
    const reset_message = {
      ...createMentionMessage("<@12345> \\reset"),
      channel_id: "chan-reset",
    };
    await handleMessage(reset_message, ctx.deps);

    assertEquals(getContext("chan-reset"), undefined);
    assertEquals(fetch_mock.postedMessages.length, 1);
    assertStringIncludes(fetch_mock.postedMessages[0], "cleared our chat context");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage exits when AI is disabled", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig({ aiEnabled: false });
    const ctx = createDeps(config);
    await handleMessage(createMentionMessage("<@12345> hello"), ctx.deps);
    assertEquals(ctx.aiCalls.length, 0);
    assertEquals(ctx.requestCount, 0);
    assertEquals(fetch_mock.postedMessages.length, 0);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage enforces rate limit and daily budget checks", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        rateLimitResult: { allowed: false, remaining: 0, resetInMs: 60000 },
      });
      await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
      assertEquals(ctx.requestCount, 0);
      assertEquals(ctx.aiCalls.length, 0);
      assertEquals(fetch_mock.postedMessages.length, 1);
      assertStringIncludes(fetch_mock.postedMessages[0], "1 minute");
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
      assertEquals(ctx.requestCount, 0);
      assertEquals(ctx.aiCalls.length, 0);
      assertEquals(fetch_mock.postedMessages.length, 1);
      assertStringIncludes(fetch_mock.postedMessages[0], "brain power");
    } finally {
      fetch_mock.restore();
    }
  }
});

Deno.test("handleMessage formats short rate-limit windows in seconds", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      rateLimitResult: { allowed: false, remaining: 0, resetInMs: 1000 },
    });
    await handleMessage(createMentionMessage("<@12345> hi"), ctx.deps);
    assertEquals(fetch_mock.postedMessages.length, 1);
    assertStringIncludes(fetch_mock.postedMessages[0], "1 second");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage supports missing author and missing webSearch service", async () => {
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

    assertEquals(ctx.webSearchCalls.length, 0);
    assertEquals(ctx.aiCalls.length, 1);
    assertEquals(fetch_mock.postedMessages.length, 1);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage handles mention with undefined content", async () => {
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
    assertEquals(ctx.aiCalls.length, 1);
    assertEquals(fetch_mock.postedMessages.length, 1);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("open command injects Untitled when fetched page has no title", async () => {
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
    assertStringIncludes(String(web_entry?.["content"] ?? ""), "Title: Untitled");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("handleMessage handles open-command disabled and malformed cases", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig({ linkOpenEnabled: false });
      const ctx = createDeps(config);
      await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
      assertEquals(ctx.aiCalls.length, 0);
      assertEquals(fetch_mock.postedMessages.length, 1);
      assertStringIncludes(fetch_mock.postedMessages[0], "turned off");
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
      assertEquals(ctx.aiCalls.length, 0);
      assertEquals(fetch_mock.postedMessages.length, 1);
      assertStringIncludes(fetch_mock.postedMessages[0], "put a link after \\open");
    } finally {
      fetch_mock.restore();
    }
  }
});

Deno.test("handleMessage handles search failure, AI failure, and reply post failure", async () => {
  {
    const fetch_mock = mockDiscordApiFetch();
    try {
      const config = createMockConfig();
      const ctx = createDeps(config, {
        webSearchResult: { ok: false, error: "search offline" },
      });
      await handleMessage(createMentionMessage("<@12345> what is deno?"), ctx.deps);
      assertEquals(ctx.webSearchCalls.length, 1);
      assertEquals(ctx.aiCalls.length, 1);
      assertEquals(fetch_mock.postedMessages.length, 1);
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
      assertEquals(ctx.aiCalls.length, 1);
      assertEquals(fetch_mock.postedMessages.length, 1);
      assertStringIncludes(fetch_mock.postedMessages[0], "brain's a bit fuzzy");
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
      assertEquals(ctx.aiCalls.length, 1);
      assertEquals(ctx.recordedTokens, [9]);
      assertEquals(fetch_mock.postedMessages.length, 1);
    } finally {
      fetch_mock.restore();
    }
  }
});

Deno.test("open command falls back to canned reply when URL stripping empties output", async () => {
  const fetch_mock = mockDiscordApiFetch();
  try {
    const config = createMockConfig();
    const ctx = createDeps(config, {
      aiResult: { ok: true, text: "https://example.com/only-link", tokensUsed: 4 },
    });
    await handleMessage(createMentionMessage("<@12345> \\open https://example.com"), ctx.deps);
    assertEquals(fetch_mock.postedMessages.length, 1);
    assertStringIncludes(fetch_mock.postedMessages[0], "I read it!");
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("getBotUserId static import still returns a cached id", async () => {
  const fetch_mock = mockDiscordApiFetch({ botId: "12345" });
  try {
    const result = await getBotUserId(createMockConfig());
    assertEquals(typeof result, "string");
  } finally {
    fetch_mock.restore();
  }
});
