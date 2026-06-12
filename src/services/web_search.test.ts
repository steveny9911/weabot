/**
 * Tests for Web Search Service
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createWebSearchService,
  formatSearchResultsForContext,
  szExtractAutoSearchQuery,
} from "./web_search.ts";
import type { AppConfig } from "../config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "test-channel",
    channelIds: ["test-channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 100000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
}

function mockFetch(
  responseBody: Record<string, unknown>,
  status = 200,
): { restore: () => void; getLastUrl: () => string | null } {
  let lastUrl: string | null = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    lastUrl = typeof input === "string" ? input : input.toString();

    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getLastUrl: () => lastUrl,
  };
}

function mockFetchRaw(
  responseText: string,
  status = 200,
): { restore: () => void; getLastUrl: () => string | null } {
  let lastUrl: string | null = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    lastUrl = typeof input === "string" ? input : input.toString();

    return Promise.resolve(
      new Response(responseText, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getLastUrl: () => lastUrl,
  };
}

// =============================================================================
// Auto-search parsing
// =============================================================================

Deno.test("szExtractAutoSearchQuery returns query for factual question", () => {
  const query = szExtractAutoSearchQuery("<@123> what is deno deploy?");
  assertEquals(query, "what is deno deploy?");
});

Deno.test("szExtractAutoSearchQuery ignores small talk", () => {
  const query = szExtractAutoSearchQuery("<@123> how are you?");
  assertEquals(query, null);
});

Deno.test("szExtractAutoSearchQuery ignores explicit search command", () => {
  const query = szExtractAutoSearchQuery("<@123> \\search deno deploy");
  assertEquals(query, null);
});

Deno.test("szExtractAutoSearchQuery ignores conversational confusion", () => {
  const query = szExtractAutoSearchQuery("<@123> what are you talking about?");
  assertEquals(query, null);
});

Deno.test("szExtractAutoSearchQuery ignores empty or command-like input", () => {
  assertEquals(szExtractAutoSearchQuery(undefined), null);
  assertEquals(szExtractAutoSearchQuery("<@123>"), null);
  assertEquals(szExtractAutoSearchQuery("<@123> search: deno"), null);
  assertEquals(szExtractAutoSearchQuery("<@123> \\reset"), null);
  assertEquals(szExtractAutoSearchQuery("<@123> tell me about deno"), null);
});

Deno.test("szExtractAutoSearchQuery ignores subjective prompts", () => {
  assertEquals(szExtractAutoSearchQuery("<@123> what do you think about this?"), null);
  assertEquals(szExtractAutoSearchQuery("<@123> should I buy this laptop?"), null);
});

// =============================================================================
// Formatting
// =============================================================================

Deno.test("formatSearchResultsForContext includes header", () => {
  const text = formatSearchResultsForContext("deno", [
    { title: "Deno", url: "https://deno.land", snippet: "A modern runtime" },
  ]);
  assertStringIncludes(text, 'Reference notes for "deno"');
  assertEquals(text.includes("https://"), false);
});

Deno.test("formatSearchResultsForContext handles empty results", () => {
  const text = formatSearchResultsForContext(" deno ", []);
  assertEquals(text, 'Reference notes for "deno": none');
});

Deno.test("formatSearchResultsForContext truncates long snippets and fills blank titles", () => {
  const longSnippet = "x".repeat(260);
  const text = formatSearchResultsForContext("deno", [
    { title: " ", url: "https://example.com", snippet: longSnippet },
  ]);

  assertStringIncludes(text, "1. Source - ");
  assertEquals(text.includes("x".repeat(210)), false);
});

Deno.test("formatSearchResultsForContext omits snippet when not provided", () => {
  const text = formatSearchResultsForContext("deno", [
    { title: "Deno", url: "https://deno.land" },
  ]);
  assertEquals(text.includes(" - "), false);
});

// =============================================================================
// Service behavior
// =============================================================================

Deno.test("web search returns error when disabled", async () => {
  const service = createWebSearchService(createMockConfig({ webSearchEnabled: false }));
  const result = await service.search("deno");
  assertEquals(result.ok, false);
});

Deno.test("web search returns error when key missing", async () => {
  const service = createWebSearchService(createMockConfig({ webSearchApiKey: undefined }));
  const result = await service.search("deno");
  assertEquals(result.ok, false);
});

Deno.test("web search returns error when query is empty", async () => {
  const service = createWebSearchService(createMockConfig());
  const result = await service.search("   ");
  assertEquals(result, { ok: false, error: "Empty search query" });
});

Deno.test("web search maps results from Brave API", async () => {
  const mock = mockFetch({
    web: {
      results: [
        {
          title: "Deno",
          url: "https://deno.land",
          description: "A modern runtime",
        },
      ],
    },
  });

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.results.length, 1);
      assertEquals(result.results[0].title, "Deno");
      assertEquals(result.results[0].url, "https://deno.land");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("web search uses maxResults parameter", async () => {
  const mock = mockFetch({ web: { results: [] } });

  try {
    const service = createWebSearchService(createMockConfig());
    await service.search("deno", 5);
    const lastUrl = mock.getLastUrl();
    const count = lastUrl ? new URL(lastUrl).searchParams.get("count") : null;
    assertEquals(count, "5");
  } finally {
    mock.restore();
  }
});

Deno.test("web search caps maxResults to [1, 10]", async () => {
  const mock = mockFetch({ web: { results: [] } });

  try {
    const service = createWebSearchService(createMockConfig());
    await service.search("deno", 999);
    const countCap = mock.getLastUrl() ? new URL(mock.getLastUrl() as string).searchParams.get("count") : null;
    assertEquals(countCap, "10");

    await service.search("deno", 0);
    const countFloor = mock.getLastUrl()
      ? new URL(mock.getLastUrl() as string).searchParams.get("count")
      : null;
    assertEquals(countFloor, "1");
  } finally {
    mock.restore();
  }
});

Deno.test("web search filters out results without urls and trims fields", async () => {
  const mock = mockFetch({
    web: {
      results: [
        { title: "  One  ", url: " https://one.example ", description: "  first  " },
        { title: "No URL", description: "skip me" },
      ],
    },
  });

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.results.length, 1);
      assertEquals(result.results[0], {
        title: "One",
        url: "https://one.example",
        snippet: "first",
      });
    }
  } finally {
    mock.restore();
  }
});

Deno.test("web search handles missing web/results payload as empty results", async () => {
  const mock = mockFetch({});

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result, { ok: true, results: [] });
  } finally {
    mock.restore();
  }
});

Deno.test("web search maps missing title/description to empty strings", async () => {
  const mock = mockFetch({
    web: {
      results: [
        { url: "https://x.example" },
      ],
    },
  });

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.results[0], {
        title: "",
        url: "https://x.example",
        snippet: "",
      });
    }
  } finally {
    mock.restore();
  }
});

Deno.test("web search returns error on non-ok response", async () => {
  const mock = mockFetch({ message: "upstream error" }, 500);
  const original_set_timeout = globalThis.setTimeout;
  const original_clear_timeout = globalThis.clearTimeout;

  globalThis.setTimeout = ((handler: unknown, _timeout?: number, ...args: unknown[]) => {
    if (typeof handler === "function") {
      (handler as (...args: unknown[]) => unknown)(...args);
    }
    return 0 as unknown as number;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((_id?: number) => {}) as typeof clearTimeout;

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "Brave Search error 500");
    }
  } finally {
    mock.restore();
    globalThis.setTimeout = original_set_timeout;
    globalThis.clearTimeout = original_clear_timeout;
  }
});

Deno.test("web search returns error when response JSON parsing fails", async () => {
  const mock = mockFetchRaw("not-json", 200);

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "SyntaxError");
    }
  } finally {
    mock.restore();
  }
});
