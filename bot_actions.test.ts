import { assertEquals, assertStringIncludes } from "@std/assert";
import { getContext, handleMessage, saveContext } from "./bot_actions.ts";
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
} = {}): DiscordFetchMock {
  const bot_id = options.botId ?? "12345";
  const recent_messages = options.recentMessages ?? [];
  const posted_messages: string[] = [];
  const original_fetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/users/@me")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: bot_id, username: "Haru" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages?limit=") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(recent_messages), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/messages") && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      posted_messages.push(String(body["content"] ?? ""));
      return Promise.resolve(
        new Response(JSON.stringify({ id: "posted-1" }), {
          status: 200,
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
      async generateReply(messages: Array<Record<string, unknown>>) {
        ai_calls.push(messages);
        return overrides.aiResult ?? { ok: true, text: "AI reply", tokensUsed: 9 };
      },
    },
    rateLimitService: {
      async checkUserRateLimit(_userId: string): Promise<RateLimitResult> {
        return { allowed: true, remaining: 99, resetInMs: 1000 };
      },
      async recordUserRequest(_userId: string): Promise<void> {
        request_count++;
      },
      async checkDailyBudget(): Promise<BudgetResult> {
        return { allowed: true, tokensRemaining: 999999 };
      },
      async recordTokenUsage(tokens: number): Promise<void> {
        recorded_tokens.push(tokens);
      },
      async getUsageStats(): Promise<UsageStats> {
        return {
          dailyTokensUsed: recorded_tokens.reduce((a, b) => a + b, 0),
          dailyTokenBudget: config.aiDailyTokenBudget,
          requestsToday: request_count,
        };
      },
    },
    linkOpenService: {
      async open(url: string) {
        link_calls.push(url);
        return overrides.linkResult ?? {
          ok: true,
          page: {
            domain: "example.com",
            title: "Example Title",
            excerpt: "Example page excerpt",
          },
        };
      },
    },
    webSearchService: {
      async search(query: string, _maxResults?: number) {
        web_search_calls.push(query);
        return overrides.webSearchResult ?? {
          ok: true,
          results: [{ title: "Deno", url: "https://deno.com", snippet: "A runtime" }],
        };
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
