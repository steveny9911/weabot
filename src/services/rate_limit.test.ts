/**
 * Tests for Rate Limit Service
 */

import { assertEquals, assertGreater, assertRejects } from "@std/assert";
import { createRateLimitService } from "./rate_limit.ts";
import type { AppConfig } from "../config.ts";

// Create a test config
function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "test-channel",
    channelIds: ["test-channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "test-key",
    aiRateLimitPerUser: 5,
    aiDailyTokenBudget: 100000,
    aiMaxInputChars: 500,
    aiEnableUwu: true,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
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

// =============================================================================
// checkUserRateLimit
// =============================================================================

Deno.test("checkUserRateLimit allows first request", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 5 });
  const service = createRateLimitService(kv, config);

  const result = await service.checkUserRateLimit("user123");

  assertEquals(result.allowed, true);
  assertEquals(result.remaining, 5);
  assertGreater(result.resetInMs, 0);

  kv.close();
});

Deno.test("checkUserRateLimit decrements remaining after recordUserRequest", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 5 });
  const service = createRateLimitService(kv, config);

  await service.recordUserRequest("user123");
  const result = await service.checkUserRateLimit("user123");

  assertEquals(result.allowed, true);
  assertEquals(result.remaining, 4);

  kv.close();
});

Deno.test("checkUserRateLimit blocks user at limit", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 2 });
  const service = createRateLimitService(kv, config);

  // Record 2 requests (at limit)
  await service.recordUserRequest("user123");
  await service.recordUserRequest("user123");

  const result = await service.checkUserRateLimit("user123");

  assertEquals(result.allowed, false);
  assertEquals(result.remaining, 0);

  kv.close();
});

// =============================================================================
// checkDailyBudget
// =============================================================================

Deno.test("checkDailyBudget allows when under budget", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  const result = await service.checkDailyBudget();

  assertEquals(result.allowed, true);
  assertEquals(result.tokensRemaining, 100000);

  kv.close();
});

Deno.test("checkDailyBudget decrements after recordTokenUsage", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  await service.recordTokenUsage(5000);
  const result = await service.checkDailyBudget();

  assertEquals(result.allowed, true);
  assertEquals(result.tokensRemaining, 95000);

  kv.close();
});

Deno.test("checkDailyBudget blocks when budget exhausted", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 10000 });
  const service = createRateLimitService(kv, config);

  await service.recordTokenUsage(10000);
  const result = await service.checkDailyBudget();

  assertEquals(result.allowed, false);
  assertEquals(result.tokensRemaining, 0);

  kv.close();
});

// =============================================================================
// getUsageStats
// =============================================================================

Deno.test("getUsageStats returns correct values", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  await service.recordUserRequest("user1");
  await service.recordUserRequest("user2");
  await service.recordTokenUsage(5000);
  await service.recordTokenUsage(3000);

  const stats = await service.getUsageStats();

  assertEquals(stats.dailyTokensUsed, 8000);
  assertEquals(stats.dailyTokenBudget, 100000);
  assertEquals(stats.requestsToday, 2);

  kv.close();
});

Deno.test("getUsageStats returns zeros when empty", async () => {
  const kv = await Deno.openKv(":memory:");
  const config = createTestConfig();
  const service = createRateLimitService(kv, config);

  const stats = await service.getUsageStats();

  assertEquals(stats.dailyTokensUsed, 0);
  assertEquals(stats.requestsToday, 0);

  kv.close();
});

// Real KV transactions are used below, including when a competing writer is
// deliberately inserted between a read and its commit.
const FIXED_NOW = Date.parse("2026-09-05T12:34:30.000Z");
const FIXED_DATE = "2026-09-05";
const FIXED_MINUTE = "2026-09-05T12:34";

function beforeCommit(kv: Deno.Kv, hook: () => Promise<void>): () => void {
  const atomic = kv.atomic.bind(kv);
  kv.atomic = () => {
    const operation = atomic();
    const commit = operation.commit.bind(operation);
    operation.commit = async () => {
      await hook();
      return await commit();
    };
    return operation;
  };
  return () => kv.atomic = atomic;
}

Deno.test("20 concurrent token updates across services retain all 2,000 tokens", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const services = Array.from(
      { length: 20 },
      () => createRateLimitService(kv, createTestConfig(), () => FIXED_NOW),
    );
    await Promise.all(services.map((service) => service.recordTokenUsage(100)));
    assertEquals((await services[0].getUsageStats()).dailyTokensUsed, 2000);
  } finally {
    kv.close();
  }
});

Deno.test("concurrent request updates retain exact per-user and daily totals", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => service.recordUserRequest(`user-${i % 3}`)),
    );
    assertEquals((await service.getUsageStats()).requestsToday, 60);
    for (let i = 0; i < 3; i++) {
      assertEquals((await kv.get(["ai_usage", "user", `user-${i}`, FIXED_MINUTE])).value, 20);
    }
  } finally {
    kv.close();
  }
});

Deno.test("one remaining user allowance admits exactly one of 20 concurrent requests", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await kv.set(["ai_usage", "user", "user", FIXED_MINUTE], 4);
    await kv.set(["ai_usage", "daily_requests", FIXED_DATE], 12);
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        () => createRateLimitService(kv, createTestConfig(), () => FIXED_NOW).admitRequest("user"),
      ),
    );
    assertEquals(results.filter((result) => result.allowed).length, 1);
    assertEquals(
      results.filter((result) => !result.allowed && result.reason === "user_limit").length,
      19,
    );
    assertEquals(
      results.every((result) => result.remaining === 0 && result.resetInMs === 30_000),
      true,
    );
    assertEquals((await kv.get(["ai_usage", "user", "user", FIXED_MINUTE])).value, 5);
    assertEquals((await kv.get(["ai_usage", "daily_requests", FIXED_DATE])).value, 13);
  } finally {
    kv.close();
  }
});

Deno.test("concurrent admissions from different users retain exact daily count", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => service.admitRequest(`u${i}`)),
    );
    assertEquals(results.every((result) => result.allowed), true);
    assertEquals((await service.getUsageStats()).requestsToday, 30);
  } finally {
    kv.close();
  }
});

Deno.test("token CAS retries a deterministic conflict and preserves legacy numeric values", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const key = ["ai_usage", "daily_tokens", FIXED_DATE];
    await kv.set(key, 10);
    let commits = 0;
    beforeCommit(kv, async () => {
      if (++commits === 1) await kv.set(key, 40);
    });
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    await service.recordTokenUsage(100);
    assertEquals(commits, 2);
    assertEquals((await kv.get(key)).value, 140);
  } finally {
    kv.close();
  }
});

Deno.test("request CAS retries without partially consuming the user allowance", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const dailyKey = ["ai_usage", "daily_requests", FIXED_DATE];
    await kv.set(dailyKey, 7);
    let commits = 0;
    beforeCommit(kv, async () => {
      if (++commits === 1) await kv.set(dailyKey, 9);
    });
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    assertEquals((await service.admitRequest("user")).allowed, true);
    assertEquals(commits, 2);
    assertEquals((await kv.get(dailyKey)).value, 10);
    assertEquals((await kv.get(["ai_usage", "user", "user", FIXED_MINUTE])).value, 1);
  } finally {
    kv.close();
  }
});

Deno.test("admission rechecks budget after completed usage races its transaction", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let commits = 0;
    beforeCommit(kv, async () => {
      if (++commits === 1) await kv.set(["ai_usage", "daily_tokens", FIXED_DATE], 100);
    });
    const service = createRateLimitService(
      kv,
      createTestConfig({ aiDailyTokenBudget: 100 }),
      () => FIXED_NOW,
    );
    const result = await service.admitRequest("user");
    assertEquals(result, {
      allowed: false,
      reason: "daily_budget",
      remaining: 5,
      resetInMs: 30_000,
    });
    assertEquals(commits, 1);
    assertEquals((await service.getUsageStats()).requestsToday, 0);
    assertEquals((await kv.get(["ai_usage", "user", "user", FIXED_MINUTE])).value, null);
  } finally {
    kv.close();
  }
});

Deno.test("persistent transaction conflicts fail explicitly after bounded retries", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let commits = 0;
    const key = ["ai_usage", "daily_requests", FIXED_DATE];
    beforeCommit(kv, async () => {
      await kv.set(key, ++commits);
    });
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    await assertRejects(() => service.admitRequest("user"), Error, "repeated conflicts");
    assertEquals(commits, 100);
    assertEquals((await kv.get(["ai_usage", "user", "user", FIXED_MINUTE])).value, null);
  } finally {
    kv.close();
  }
});

Deno.test("manual and autonomous in-flight requests may exceed the soft daily threshold", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const config = createTestConfig({ aiDailyTokenBudget: 100, aiRateLimitPerUser: 1 });
    const service = createRateLimitService(kv, config, () => FIXED_NOW);
    await service.recordTokenUsage(99);
    const admitted = await Promise.all([
      service.admitRequest("user"),
      service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
      service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
    ]);
    assertEquals(admitted.every((result) => result.allowed), true);
    assertEquals((await service.checkDailyBudget()).tokensRemaining, 1);
    await Promise.all([10, 20, 30].map((tokens) => service.recordTokenUsage(tokens)));
    assertEquals(await service.getUsageStats(), {
      dailyTokensUsed: 159,
      dailyTokenBudget: 100,
      requestsToday: 3,
    });
    assertEquals(await service.checkDailyBudget(), { allowed: false, tokensRemaining: 0 });
    const manual = await service.admitRequest("other-user");
    const autonomous = await service.admitRequest("autonomous-chat", { enforceUserLimit: false });
    assertEquals(!manual.allowed && manual.reason, "daily_budget");
    assertEquals(!autonomous.allowed && autonomous.reason, "daily_budget");
    assertEquals((await service.getUsageStats()).requestsToday, 3);
  } finally {
    kv.close();
  }
});

Deno.test("UTC minute and day rollover start fresh buckets without splitting request counters", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let time = Date.parse("2026-09-05T23:59:59.500Z");
    const service = createRateLimitService(
      kv,
      createTestConfig({ aiRateLimitPerUser: 1, aiDailyTokenBudget: 10 }),
      () => time,
    );
    assertEquals((await service.admitRequest("user")).allowed, true);
    await service.recordTokenUsage(10);
    time += 500;
    assertEquals(await service.checkDailyBudget(), { allowed: true, tokensRemaining: 10 });
    assertEquals(await service.admitRequest("user"), {
      allowed: true,
      remaining: 0,
      resetInMs: 60_000,
    });
    // An AI call finishing after midnight is charged to its recording day.
    await service.recordTokenUsage(7);
    assertEquals(await service.getUsageStats(), {
      dailyTokensUsed: 7,
      dailyTokenBudget: 10,
      requestsToday: 1,
    });
    assertEquals((await kv.get(["ai_usage", "daily_requests", "2026-09-05"])).value, 1);
    assertEquals((await kv.get(["ai_usage", "daily_tokens", "2026-09-05"])).value, 10);
    time += 60_000;
    assertEquals((await service.admitRequest("user")).allowed, true);
    assertEquals((await service.getUsageStats()).requestsToday, 2);
  } finally {
    kv.close();
  }
});

Deno.test("admission crossing midnight while reading retries into the new day", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let time = Date.parse("2026-09-05T23:59:59.500Z");
    const getMany = kv.getMany.bind(kv);
    kv.getMany = async (...args) => {
      const result = await getMany(...args);
      time = Date.parse("2026-09-06T00:00:00.000Z");
      return result;
    };
    const service = createRateLimitService(kv, createTestConfig(), () => time);
    assertEquals((await service.admitRequest("user")).allowed, true);
    assertEquals((await kv.get(["ai_usage", "daily_requests", "2026-09-05"])).value, null);
    assertEquals((await kv.get(["ai_usage", "daily_requests", "2026-09-06"])).value, 1);
    assertEquals((await kv.get(["ai_usage", "user", "user", "2026-09-06T00:00"])).value, 1);
  } finally {
    kv.close();
  }
});

Deno.test("token conflict retries stay on their original recording day", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let time = Date.parse("2026-09-05T23:59:59.500Z");
    let commits = 0;
    beforeCommit(kv, async () => {
      if (++commits === 1) {
        await kv.set(["ai_usage", "daily_tokens", "2026-09-05"], 5);
        time += 500;
      }
    });
    const service = createRateLimitService(kv, createTestConfig(), () => time);
    await service.recordTokenUsage(7);
    assertEquals(commits, 2);
    assertEquals((await kv.get(["ai_usage", "daily_tokens", "2026-09-05"])).value, 12);
    assertEquals((await service.getUsageStats()).dailyTokensUsed, 0);
  } finally {
    kv.close();
  }
});

Deno.test("atomic counter writes preserve the two-minute and 48-hour expirations", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const expirations: Array<[string, number | undefined]> = [];
    const atomic = kv.atomic.bind(kv);
    kv.atomic = () => {
      const operation = atomic();
      const set = operation.set.bind(operation);
      operation.set = (key, value, options) => {
        expirations.push([String(key[1]), options?.expireIn]);
        return set(key, value, options);
      };
      return operation;
    };
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    await service.admitRequest("user");
    await service.recordTokenUsage(10);
    assertEquals(expirations, [["user", 120000], ["daily_requests", 172800000], [
      "daily_tokens",
      172800000,
    ]]);
  } finally {
    kv.close();
  }
});

Deno.test("invalid token reports cannot reduce or corrupt the budget counter", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const service = createRateLimitService(kv, createTestConfig(), () => FIXED_NOW);
    await service.recordTokenUsage(12);
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assertRejects(() => service.recordTokenUsage(invalid), RangeError);
    }
    assertEquals((await service.getUsageStats()).dailyTokensUsed, 12);
  } finally {
    kv.close();
  }
});
