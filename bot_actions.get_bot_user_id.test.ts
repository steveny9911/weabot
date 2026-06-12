import { assertEquals } from "@std/assert";
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

Deno.test("getBotUserId returns undefined when discord token is missing", async () => {
  const result = await getBotUserId(createMockConfig({ discordToken: "" }));
  assertEquals(result, undefined);
});

Deno.test("getBotUserId returns undefined when Discord API responds non-ok", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.resolve(new Response("bad", { status: 401 }));
  }) as typeof fetch;

  try {
    const result = await getBotUserId(createMockConfig());
    assertEquals(result, undefined);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

Deno.test("getBotUserId returns undefined when fetch throws", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.reject(new Error("users me failed"));
  }) as typeof fetch;

  try {
    const result = await getBotUserId(createMockConfig());
    assertEquals(result, undefined);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

Deno.test("getBotUserId caches fetched value across calls", async () => {
  let calls = 0;
  const original_fetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "cached-123", username: "Haru" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const first = await getBotUserId(createMockConfig());
    const second = await getBotUserId(createMockConfig());
    assertEquals(first, "cached-123");
    assertEquals(second, "cached-123");
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = original_fetch;
  }
});
