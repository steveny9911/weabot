import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { getBotUserId } from "./messages.ts";
import type { AppConfig } from "../config.ts";
import { testConfig } from "../../tests/support/config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    channelId: "chan-1",
    channelIds: ["chan-1"],
    timeZone: "America/Los_Angeles",
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    webSearchEnabled: true,
    webSearchApiKey: "brave-key",
    autonomousChatChannelIds: ["chan-1"],
    ...overrides,
  });
}

test("getBotUserId returns undefined when discord token is missing", async () => {
  const result = await getBotUserId(createMockConfig({ discordToken: "" }));
  expect(result).toStrictEqual(undefined);
});

test("getBotUserId returns undefined when Discord API responds non-ok", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response("bad", { status: 401 }));
  });

  try {
    const result = await getBotUserId(createMockConfig());
    expect(result).toStrictEqual(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBotUserId returns undefined when fetch throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.reject(new Error("users me failed"));
  });

  try {
    const result = await getBotUserId(createMockConfig());
    expect(result).toStrictEqual(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBotUserId caches fetched value across calls", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "cached-123", username: "Haru" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const first = await getBotUserId(createMockConfig());
    const second = await getBotUserId(createMockConfig());
    expect(first).toStrictEqual("cached-123");
    expect(second).toStrictEqual("cached-123");
    expect(calls).toStrictEqual(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
