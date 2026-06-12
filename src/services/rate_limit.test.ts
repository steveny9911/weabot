/**
 * Tests for Rate Limit Service
 */

import { assertEquals, assertGreater } from "@std/assert";
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
    webSearchEnabled: false,
    webSearchApiKey: undefined,
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
