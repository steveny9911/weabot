/**
 * Tests for Rate Limit Service
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejects } from "../../tests/support/assert.ts";
import { type Database, openDatabase } from "../db/database.ts";
import { deleteOldAiUsage } from "../db/maintenance.ts";
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

test("checkUserRateLimit allows first request", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 5 });
  const service = createRateLimitService(kv, config);

  const result = await service.checkUserRateLimit("user123");

  expect(result.allowed).toStrictEqual(true);
  expect(result.remaining).toStrictEqual(5);
  expect(result.resetInMs).toBeGreaterThan(0);

  kv.close();
});

test("checkUserRateLimit decrements remaining after recordUserRequest", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 5 });
  const service = createRateLimitService(kv, config);

  await service.recordUserRequest("user123");
  const result = await service.checkUserRateLimit("user123");

  expect(result.allowed).toStrictEqual(true);
  expect(result.remaining).toStrictEqual(4);

  kv.close();
});

test("checkUserRateLimit blocks user at limit", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 2 });
  const service = createRateLimitService(kv, config);

  // Record 2 requests (at limit)
  await service.recordUserRequest("user123");
  await service.recordUserRequest("user123");

  const result = await service.checkUserRateLimit("user123");

  expect(result.allowed).toStrictEqual(false);
  expect(result.remaining).toStrictEqual(0);

  kv.close();
});

// =============================================================================
// checkDailyBudget
// =============================================================================

test("checkDailyBudget allows when under budget", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  const result = await service.checkDailyBudget();

  expect(result.allowed).toStrictEqual(true);
  expect(result.tokensRemaining).toStrictEqual(100000);

  kv.close();
});

test("checkDailyBudget decrements after recordTokenUsage", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  await service.recordTokenUsage(5000);
  const result = await service.checkDailyBudget();

  expect(result.allowed).toStrictEqual(true);
  expect(result.tokensRemaining).toStrictEqual(95000);

  kv.close();
});

test("checkDailyBudget blocks when budget exhausted", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 10000 });
  const service = createRateLimitService(kv, config);

  await service.recordTokenUsage(10000);
  const result = await service.checkDailyBudget();

  expect(result.allowed).toStrictEqual(false);
  expect(result.tokensRemaining).toStrictEqual(0);

  kv.close();
});

// =============================================================================
// getUsageStats
// =============================================================================

test("getUsageStats returns correct values", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100000 });
  const service = createRateLimitService(kv, config);

  await service.recordUserRequest("user1");
  await service.recordUserRequest("user2");
  await service.recordTokenUsage(5000);
  await service.recordTokenUsage(3000);

  const stats = await service.getUsageStats();

  expect(stats.dailyTokensUsed).toStrictEqual(8000);
  expect(stats.dailyTokenBudget).toStrictEqual(100000);
  expect(stats.requestsToday).toStrictEqual(2);

  kv.close();
});

test("getUsageStats returns zeros when empty", async () => {
  const kv = openDatabase(":memory:");
  const config = createTestConfig();
  const service = createRateLimitService(kv, config);

  const stats = await service.getUsageStats();

  expect(stats.dailyTokensUsed).toStrictEqual(0);
  expect(stats.requestsToday).toStrictEqual(0);

  kv.close();
});

// Behavior tests on a real in-memory SQLite database. The KV-era tests that forced transaction
// conflicts are replaced by the behaviors they protected (see the plan's test-count table).
const FIXED_NOW = Date.parse("2026-09-05T12:34:30.000Z");
const FIXED_DATE = "2026-09-05";

function dailyRow(db: Database, date: string) {
  return db
    .query<{ requests: number; tokens: number }, [string]>(
      "SELECT requests, tokens FROM ai_daily_usage WHERE usage_date = ?",
    )
    .get(date);
}

test("20 concurrent token updates across services retain all 2,000 tokens", async () => {
  using db = openDatabase(":memory:");
  const services = Array.from({ length: 20 }, () =>
    createRateLimitService(db, createTestConfig(), () => FIXED_NOW),
  );
  await Promise.all(services.map((service) => service.recordTokenUsage(100)));
  expect((await services[0].getUsageStats()).dailyTokensUsed).toBe(2000);
});

test("concurrent request updates retain exact per-user and daily totals", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(
    db,
    createTestConfig({ aiRateLimitPerUser: 100 }),
    () => FIXED_NOW,
  );
  await Promise.all(
    Array.from({ length: 60 }, (_, i) => service.recordUserRequest(`user-${i % 3}`)),
  );
  expect((await service.getUsageStats()).requestsToday).toBe(60);
  for (let i = 0; i < 3; i++) {
    expect((await service.checkUserRateLimit(`user-${i}`)).remaining).toBe(80);
  }
});

test("one remaining user allowance admits exactly one of 20 concurrent requests", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  for (let i = 0; i < 4; i++) await service.recordUserRequest("user");
  const results = await Promise.all(Array.from({ length: 20 }, () => service.admitRequest("user")));
  expect(results.filter((result) => result.allowed).length).toBe(1);
  expect(results.filter((result) => !result.allowed && result.reason === "user_limit").length).toBe(
    19,
  );
  expect(results.every((result) => result.remaining === 0 && result.resetInMs === 30_000)).toBe(
    true,
  );
  expect(await service.checkUserRateLimit("user")).toStrictEqual({
    allowed: false,
    remaining: 0,
    resetInMs: 30_000,
  });
  expect(dailyRow(db, FIXED_DATE)?.requests).toBe(5);
});

test("concurrent admissions from different users retain exact daily count", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => service.admitRequest(`u${i}`)),
  );
  expect(results.every((result) => result.allowed)).toBe(true);
  expect((await service.getUsageStats()).requestsToday).toBe(30);
});

test("token totals stop at the safe integer limit without changing the stored total", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  await service.recordTokenUsage(Number.MAX_SAFE_INTEGER - 5);
  await rejects(() => service.recordTokenUsage(6), RangeError, "AI token counter overflow");
  await service.recordTokenUsage(5);
  expect((await service.getUsageStats()).dailyTokensUsed).toBe(Number.MAX_SAFE_INTEGER);
});

test("a failed daily count write consumes no per-user allowance", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  db.run(`CREATE TRIGGER fail_usage BEFORE INSERT ON ai_daily_usage
          BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  await rejects(() => service.admitRequest("user"), Error, "simulated write failure");
  db.run("DROP TRIGGER fail_usage");
  expect((await service.checkUserRateLimit("user")).remaining).toBe(5);
  expect(dailyRow(db, FIXED_DATE)).toBeNull();
  expect((await service.admitRequest("user")).remaining).toBe(4);
});

test("a failed commit consumes no per-user allowance", async () => {
  using db = openDatabase(":memory:");
  let failCommit = true;
  // Runs the transaction body, then fails as a COMMIT would (SQLite rolls the body back).
  const failingDb = new Proxy(db, {
    get(target, property) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (body: (...args: never[]) => unknown) => {
        const transaction = target.transaction(body);
        return Object.assign((...args: never[]) => transaction(...args), {
          immediate: (...args: never[]) => {
            if (!failCommit) return transaction.immediate(...args);
            target.run("BEGIN IMMEDIATE");
            try {
              body(...args);
            } finally {
              target.run("ROLLBACK");
            }
            throw new Error("simulated commit failure");
          },
        });
      };
    },
  });
  const service = createRateLimitService(failingDb, createTestConfig(), () => FIXED_NOW);
  await rejects(() => service.admitRequest("user"), Error, "simulated commit failure");
  expect((await service.checkUserRateLimit("user")).remaining).toBe(5);
  expect(dailyRow(db, FIXED_DATE)).toBeNull();
  failCommit = false;
  expect((await service.admitRequest("user")).remaining).toBe(4);
});

test("admission rechecks the budget against usage reported just before it", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(
    db,
    createTestConfig({ aiDailyTokenBudget: 100 }),
    () => FIXED_NOW,
  );
  const [, result] = await Promise.all([
    service.recordTokenUsage(100),
    service.admitRequest("user"),
  ]);
  expect(result).toStrictEqual({
    allowed: false,
    reason: "daily_budget",
    remaining: 5,
    resetInMs: 30_000,
  });
  expect((await service.getUsageStats()).requestsToday).toBe(0);
  expect((await service.checkUserRateLimit("user")).remaining).toBe(5);
});

test("a daily request count beyond the safe integer range fails without partial counting", async () => {
  using db = openDatabase(":memory:");
  db.run("INSERT INTO ai_daily_usage (usage_date, requests) VALUES (?, ?)", [
    FIXED_DATE,
    Number.MAX_SAFE_INTEGER,
  ]);
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  await rejects(() => service.admitRequest("user"), Error, "CHECK constraint failed");
  expect((await service.checkUserRateLimit("user")).remaining).toBe(5);
  expect(dailyRow(db, FIXED_DATE)?.requests).toBe(Number.MAX_SAFE_INTEGER);
});

test("manual and autonomous in-flight requests may exceed the soft daily threshold", async () => {
  using db = openDatabase(":memory:");
  const config = createTestConfig({ aiDailyTokenBudget: 100, aiRateLimitPerUser: 1 });
  const service = createRateLimitService(db, config, () => FIXED_NOW);
  await service.recordTokenUsage(99);
  const admitted = await Promise.all([
    service.admitRequest("user"),
    service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
    service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
  ]);
  expect(admitted.every((result) => result.allowed)).toBe(true);
  expect((await service.checkDailyBudget()).tokensRemaining).toBe(1);
  await Promise.all([10, 20, 30].map((tokens) => service.recordTokenUsage(tokens)));
  expect(await service.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 159,
    dailyTokenBudget: 100,
    requestsToday: 3,
  });
  expect(await service.checkDailyBudget()).toStrictEqual({ allowed: false, tokensRemaining: 0 });
  const manual = await service.admitRequest("other-user");
  const autonomous = await service.admitRequest("autonomous-chat", { enforceUserLimit: false });
  expect(!manual.allowed && manual.reason).toBe("daily_budget");
  expect(!autonomous.allowed && autonomous.reason).toBe("daily_budget");
  expect((await service.getUsageStats()).requestsToday).toBe(3);
});

test("UTC minute and day rollover start fresh buckets without splitting request counters", async () => {
  using db = openDatabase(":memory:");
  let time = Date.parse("2026-09-05T23:59:59.500Z");
  const service = createRateLimitService(
    db,
    createTestConfig({ aiRateLimitPerUser: 1, aiDailyTokenBudget: 10 }),
    () => time,
  );
  expect((await service.admitRequest("user")).allowed).toBe(true);
  await service.recordTokenUsage(10);
  time += 500;
  expect(await service.checkDailyBudget()).toStrictEqual({ allowed: true, tokensRemaining: 10 });
  expect(await service.admitRequest("user")).toStrictEqual({
    allowed: true,
    remaining: 0,
    resetInMs: 60_000,
  });
  // An AI call finishing after midnight is charged to its recording day.
  await service.recordTokenUsage(7);
  expect(await service.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 7,
    dailyTokenBudget: 10,
    requestsToday: 1,
  });
  expect(dailyRow(db, "2026-09-05")).toStrictEqual({ requests: 1, tokens: 10 });
  time += 60_000;
  expect((await service.admitRequest("user")).allowed).toBe(true);
  expect((await service.getUsageStats()).requestsToday).toBe(2);
});

test("a restart resets per-user minute counts but keeps the daily totals", async () => {
  using db = openDatabase(":memory:");
  const config = createTestConfig({ aiRateLimitPerUser: 1 });
  const before = createRateLimitService(db, config, () => FIXED_NOW);
  expect((await before.admitRequest("user")).allowed).toBe(true);
  await before.recordTokenUsage(25);
  expect((await before.admitRequest("user")).allowed).toBe(false);
  // Behavior change 2: the per-minute allowance is in memory.
  const restarted = createRateLimitService(db, config, () => FIXED_NOW);
  expect((await restarted.admitRequest("user")).allowed).toBe(true);
  expect(await restarted.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 25,
    dailyTokenBudget: config.aiDailyTokenBudget,
    requestsToday: 2,
  });
});

test("daily totals survive reopening the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "haru-usage-"));
  try {
    const path = join(dir, "nested", "haru.sqlite3");
    {
      using db = openDatabase(path);
      const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
      await service.admitRequest("user");
      await service.recordTokenUsage(42);
    }
    using db = openDatabase(path);
    const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
    expect(await service.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 42,
      dailyTokenBudget: 100000,
      requestsToday: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance deletes AI usage older than 30 days and keeps newer days", async () => {
  using db = openDatabase(":memory:");
  for (const date of ["2026-08-05", "2026-08-06", "2026-09-05"]) {
    db.run("INSERT INTO ai_daily_usage (usage_date, tokens) VALUES (?, 1)", [date]);
  }
  expect(deleteOldAiUsage(db, FIXED_NOW)).toBe(1);
  expect(dailyRow(db, "2026-08-05")).toBeNull();
  expect(dailyRow(db, "2026-08-06")).not.toBeNull();
  expect(dailyRow(db, "2026-09-05")).not.toBeNull();
});

test("invalid token reports cannot reduce or corrupt the budget counter", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, createTestConfig(), () => FIXED_NOW);
  await service.recordTokenUsage(12);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(() => service.recordTokenUsage(invalid), RangeError, "non-negative safe integer");
  }
  expect((await service.getUsageStats()).dailyTokensUsed).toBe(12);
});
