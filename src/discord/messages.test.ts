import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { getBotUserId, timeoutMember } from "./messages.ts";
import type { AppConfig } from "../config.ts";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";

function createMockConfig(overrides: ConfigOverrides = {}): AppConfig {
  return testConfig(
    {
      channelId: "chan-1",
      channelIds: ["chan-1"],
      timeZone: "America/Los_Angeles",
      aiApiKey: "sk-test-key",
      aiRateLimitPerUser: 2,
      aiDailyTokenBudget: 10000000,
      webSearch: { enabled: true, apiKey: "brave-key" },
      autonomousChat: { channelIds: ["chan-1"] },
    },
    overrides,
  );
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

test("timeoutMember patches the member with a timeout end and an audit reason", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const before = Date.now();
    const result = await timeoutMember(createMockConfig(), "guild-1", "user-1", 60, "Because");
    expect(result).toStrictEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url).toBe("https://discord.com/api/v10/guilds/guild-1/members/user-1");
    expect(init?.method).toBe("PATCH");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bot test-token");
    expect(headers["X-Audit-Log-Reason"]).toBe("Because");
    const until = Date.parse(JSON.parse(init?.body as string).communication_disabled_until);
    expect(until).toBeGreaterThanOrEqual(before + 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeoutMember reports a Discord refusal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch(() =>
    Promise.resolve(new Response("Missing Permissions", { status: 403 })),
  );
  try {
    const result = await timeoutMember(createMockConfig(), "guild-1", "user-1", 60, "Because");
    expect(result).toStrictEqual({
      ok: false,
      error: "Discord timeout error 403: Missing Permissions",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeoutMember reports a network error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch(() => Promise.reject(new Error("offline")));
  try {
    const result = await timeoutMember(createMockConfig(), "guild-1", "user-1", 60, "Because");
    expect(result.ok).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
