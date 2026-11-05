/**
 * Tests for Web Search Service
 */

import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import {
  createWebSearchService,
  formatSearchResultsForContext,
  extractAutoSearchQuery,
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
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: ["test-channel"],
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

  globalThis.fetch = asFetch((input: string | URL | Request, _init?: RequestInit) => {
    lastUrl = typeof input === "string" ? input : input.toString();

    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

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

  globalThis.fetch = asFetch((input: string | URL | Request, _init?: RequestInit) => {
    lastUrl = typeof input === "string" ? input : input.toString();

    return Promise.resolve(
      new Response(responseText, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

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

test("extractAutoSearchQuery returns query for factual question", () => {
  const query = extractAutoSearchQuery("<@123> what is deno deploy?");
  expect(query).toStrictEqual("what is deno deploy?");
});

test("extractAutoSearchQuery ignores small talk", () => {
  const query = extractAutoSearchQuery("<@123> how are you?");
  expect(query).toStrictEqual(null);
});

test("extractAutoSearchQuery ignores explicit search command", () => {
  const query = extractAutoSearchQuery("<@123> \\search deno deploy");
  expect(query).toStrictEqual(null);
});

test("extractAutoSearchQuery ignores conversational confusion", () => {
  const query = extractAutoSearchQuery("<@123> what are you talking about?");
  expect(query).toStrictEqual(null);
});

test("extractAutoSearchQuery ignores empty or command-like input", () => {
  expect(extractAutoSearchQuery(undefined)).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123>")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> search: deno")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> \\reset")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> tell me about deno")).toStrictEqual(null);
});

test("extractAutoSearchQuery ignores subjective prompts", () => {
  expect(extractAutoSearchQuery("<@123> what do you think about this?")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> should I buy this laptop?")).toStrictEqual(null);
});

// =============================================================================
// Formatting
// =============================================================================

test("formatSearchResultsForContext includes header", () => {
  const text = formatSearchResultsForContext("deno", [
    { title: "Deno", url: "https://deno.land", snippet: "A modern runtime" },
  ]);
  expect(text).toContain('Reference notes for "deno"');
  expect(text.includes("https://")).toStrictEqual(false);
});

test("formatSearchResultsForContext handles empty results", () => {
  const text = formatSearchResultsForContext(" deno ", []);
  expect(text).toStrictEqual('Reference notes for "deno": none');
});

test("formatSearchResultsForContext truncates long snippets and fills blank titles", () => {
  const longSnippet = "x".repeat(260);
  const text = formatSearchResultsForContext("deno", [
    { title: " ", url: "https://example.com", snippet: longSnippet },
  ]);

  expect(text).toContain("1. Source - ");
  expect(text.includes("x".repeat(210))).toStrictEqual(false);
});

test("formatSearchResultsForContext omits snippet when not provided", () => {
  const text = formatSearchResultsForContext("deno", [{ title: "Deno", url: "https://deno.land" }]);
  expect(text.includes(" - ")).toStrictEqual(false);
});

// =============================================================================
// Service behavior
// =============================================================================

test("web search returns error when disabled", async () => {
  const service = createWebSearchService(createMockConfig({ webSearchEnabled: false }));
  const result = await service.search("deno");
  expect(result.ok).toStrictEqual(false);
});

test("web search returns error when key missing", async () => {
  const service = createWebSearchService(createMockConfig({ webSearchApiKey: undefined }));
  const result = await service.search("deno");
  expect(result.ok).toStrictEqual(false);
});

test("web search returns error when query is empty", async () => {
  const service = createWebSearchService(createMockConfig());
  const result = await service.search("   ");
  expect(result).toStrictEqual({ ok: false, error: "Empty search query" });
});

test("web search maps results from Brave API", async () => {
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
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.results.length).toStrictEqual(1);
      expect(result.results[0].title).toStrictEqual("Deno");
      expect(result.results[0].url).toStrictEqual("https://deno.land");
    }
  } finally {
    mock.restore();
  }
});

test("web search uses maxResults parameter", async () => {
  const mock = mockFetch({ web: { results: [] } });

  try {
    const service = createWebSearchService(createMockConfig());
    await service.search("deno", 5);
    const lastUrl = mock.getLastUrl();
    const count = lastUrl ? new URL(lastUrl).searchParams.get("count") : null;
    expect(count).toStrictEqual("5");
  } finally {
    mock.restore();
  }
});

test("web search caps maxResults to [1, 10]", async () => {
  const mock = mockFetch({ web: { results: [] } });

  try {
    const service = createWebSearchService(createMockConfig());
    await service.search("deno", 999);
    const countCap = mock.getLastUrl()
      ? new URL(mock.getLastUrl() as string).searchParams.get("count")
      : null;
    expect(countCap).toStrictEqual("10");

    await service.search("deno", 0);
    const countFloor = mock.getLastUrl()
      ? new URL(mock.getLastUrl() as string).searchParams.get("count")
      : null;
    expect(countFloor).toStrictEqual("1");
  } finally {
    mock.restore();
  }
});

test("web search filters out results without urls and trims fields", async () => {
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
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.results.length).toStrictEqual(1);
      expect(result.results[0]).toStrictEqual({
        title: "One",
        url: "https://one.example",
        snippet: "first",
      });
    }
  } finally {
    mock.restore();
  }
});

test("web search handles missing web/results payload as empty results", async () => {
  const mock = mockFetch({});

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    expect(result).toStrictEqual({ ok: true, results: [] });
  } finally {
    mock.restore();
  }
});

test("web search maps missing title/description to empty strings", async () => {
  const mock = mockFetch({
    web: {
      results: [{ url: "https://x.example" }],
    },
  });

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.results[0]).toStrictEqual({
        title: "",
        url: "https://x.example",
        snippet: "",
      });
    }
  } finally {
    mock.restore();
  }
});

test("web search returns error on non-ok response", async () => {
  const mock = mockFetch({ message: "upstream error" }, 500);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(_target, _thisArg, [handler, _timeout, ...args]) {
      if (typeof handler === "function") handler(...args);
      return 0;
    },
  });
  globalThis.clearTimeout = new Proxy(originalClearTimeout, { apply() {} });

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    expect(result.ok).toStrictEqual(false);
    if (!result.ok) {
      expect(result.error).toContain("Brave Search error 500");
    }
  } finally {
    mock.restore();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("web search returns error when response JSON parsing fails", async () => {
  const mock = mockFetchRaw("not-json", 200);

  try {
    const service = createWebSearchService(createMockConfig());
    const result = await service.search("deno");
    expect(result.ok).toStrictEqual(false);
    if (!result.ok) {
      expect(result.error).toContain("SyntaxError");
    }
  } finally {
    mock.restore();
  }
});
