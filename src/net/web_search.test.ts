import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import {
  createWebSearchService,
  formatSearchResultsForContext,
  extractAutoSearchQuery,
} from "./web_search.ts";
import type { AppConfig } from "../config.ts";
import { testConfig } from "../../tests/support/config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    ...overrides,
  });
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

test("extractAutoSearchQuery returns query for factual question", () => {
  const query = extractAutoSearchQuery("<@123> what is deno deploy?");
  expect(query).toStrictEqual("what is deno deploy?");
});

test("extractAutoSearchQuery ignores small talk", () => {
  const query = extractAutoSearchQuery("<@123> how are you?");
  expect(query).toStrictEqual(null);
});
test("extractAutoSearchQuery ignores empty or command-like input", () => {
  expect(extractAutoSearchQuery(undefined)).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123>")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> search: deno")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> \\reset")).toStrictEqual(null);
  expect(extractAutoSearchQuery("<@123> tell me about deno")).toStrictEqual(null);
});
test("formatSearchResultsForContext truncates long snippets and fills blank titles", () => {
  const longSnippet = "x".repeat(260);
  const text = formatSearchResultsForContext("deno", [
    { title: " ", url: "https://example.com", snippet: longSnippet },
  ]);

  expect(text).toContain("1. Source - ");
  expect(text.includes("x".repeat(210))).toStrictEqual(false);
});

test("web search returns error when disabled", async () => {
  const service = createWebSearchService(createMockConfig({ webSearchEnabled: false }));
  const result = await service.search("deno");
  expect(result.ok).toStrictEqual(false);
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
