import { expect, test } from "bun:test";
import { asFetch } from "./test_support/fetch.ts";
import { getBotUserId } from "./bot_actions.ts";
import type { AppConfig } from "./src/config.ts";

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

test("getBotUserId returns undefined when discord token is missing", async () => {
  const result = await getBotUserId(createMockConfig({ discordToken: "" }));
  expect(result).toStrictEqual(undefined);
});

test("getBotUserId returns undefined when Discord API responds non-ok", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response("bad", { status: 401 }));
  });

  try {
    const result = await getBotUserId(createMockConfig());
    expect(result).toStrictEqual(undefined);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("getBotUserId returns undefined when fetch throws", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.reject(new Error("users me failed"));
  });

  try {
    const result = await getBotUserId(createMockConfig());
    expect(result).toStrictEqual(undefined);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("getBotUserId caches fetched value across calls", async () => {
  let calls = 0;
  const original_fetch = globalThis.fetch;
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
    globalThis.fetch = original_fetch;
  }
});
