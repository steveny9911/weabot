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
