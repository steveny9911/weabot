import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejects } from "../../tests/support/assert.ts";
import { type Database, openDatabase } from "../db/database.ts";
import { createRateLimitService } from "./rate_limit.ts";
import type { AppConfig } from "../config.ts";

const NOW = Date.parse("2026-09-05T12:34:30.000Z");
const config = (overrides: Partial<AppConfig> = {}) =>
  ({ aiRateLimitPerUser: 5, aiDailyTokenBudget: 100_000, ...overrides }) as AppConfig;

function dailyRow(db: Database, date: string) {
  return db
    .query<{ requests: number; tokens: number }, [string]>(
      "SELECT requests, tokens FROM ai_daily_usage WHERE usage_date = ?",
    )
    .get(date);
}

test("a user is limited per UTC minute and can ask again in the next minute", async () => {
  using db = openDatabase(":memory:");
  let time = NOW;
  const service = createRateLimitService(db, config({ aiRateLimitPerUser: 2 }), () => time);
  expect(await service.admitRequest("user")).toStrictEqual({
    allowed: true,
    remaining: 1,
    resetInMs: 30_000,
  });
  expect((await service.admitRequest("user")).allowed).toBe(true);
  expect(await service.admitRequest("user")).toStrictEqual({
    allowed: false,
    reason: "user_limit",
    remaining: 0,
    resetInMs: 30_000,
  });
  expect((await service.admitRequest("other")).allowed).toBe(true);
  time += 30_000;
  expect((await service.admitRequest("user")).allowed).toBe(true);
  expect((await service.getUsageStats()).requestsToday).toBe(4);
});

test("one remaining user allowance admits exactly one of 20 concurrent requests", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, config(), () => NOW);
  for (let i = 0; i < 4; i++) await service.admitRequest("user");
  const results = await Promise.all(Array.from({ length: 20 }, () => service.admitRequest("user")));
  expect(results.filter((result) => result.allowed).length).toBe(1);
  expect(dailyRow(db, "2026-09-05")?.requests).toBe(5);
});

test("a failed daily count write consumes no per-user allowance", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, config(), () => NOW);
  db.run(`CREATE TRIGGER fail_usage BEFORE INSERT ON ai_daily_usage
          BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  await rejects(() => service.admitRequest("user"), Error, "simulated write failure");
  db.run("DROP TRIGGER fail_usage");
  expect(dailyRow(db, "2026-09-05")).toBeNull();
  expect((await service.admitRequest("user")).remaining).toBe(4);
});

test("the daily budget is a soft threshold: admitted requests may finish above it", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(
    db,
    config({ aiDailyTokenBudget: 100, aiRateLimitPerUser: 1 }),
    () => NOW,
  );
  await service.recordTokenUsage(99);
  const admitted = await Promise.all([
    service.admitRequest("user"),
    service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
    service.admitRequest("autonomous-chat", { enforceUserLimit: false }),
  ]);
  expect(admitted.every((result) => result.allowed)).toBe(true);
  await Promise.all([10, 20, 30].map((tokens) => service.recordTokenUsage(tokens)));
  expect(await service.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 159,
    dailyTokenBudget: 100,
    requestsToday: 3,
  });
  const manual = await service.admitRequest("other-user");
  const autonomous = await service.admitRequest("autonomous-chat", { enforceUserLimit: false });
  expect(!manual.allowed && manual.reason).toBe("daily_budget");
  expect(!autonomous.allowed && autonomous.reason).toBe("daily_budget");
  expect((await service.getUsageStats()).requestsToday).toBe(3);
});

test("a new UTC day starts a fresh budget; late token reports count toward the day they arrive", async () => {
  using db = openDatabase(":memory:");
  let time = Date.parse("2026-09-05T23:59:59.500Z");
  const service = createRateLimitService(
    db,
    config({ aiRateLimitPerUser: 1, aiDailyTokenBudget: 10 }),
    () => time,
  );
  expect((await service.admitRequest("user")).allowed).toBe(true);
  await service.recordTokenUsage(10);
  time += 500;
  expect((await service.admitRequest("user")).allowed).toBe(true);
  await service.recordTokenUsage(7);
  expect(await service.getUsageStats()).toStrictEqual({
    dailyTokensUsed: 7,
    dailyTokenBudget: 10,
    requestsToday: 1,
  });
  expect(dailyRow(db, "2026-09-05")).toStrictEqual({ requests: 1, tokens: 10 });
});

test("concurrent token reports from several services are all counted", async () => {
  using db = openDatabase(":memory:");
  const services = Array.from({ length: 20 }, () =>
    createRateLimitService(db, config(), () => NOW),
  );
  await Promise.all(services.map((service) => service.recordTokenUsage(100)));
  expect((await services[0].getUsageStats()).dailyTokensUsed).toBe(2000);
});

test("daily totals survive reopening the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "haru-usage-"));
  try {
    const path = join(dir, "nested", "haru.sqlite3");
    {
      using db = openDatabase(path);
      const service = createRateLimitService(db, config(), () => NOW);
      await service.admitRequest("user");
      await service.recordTokenUsage(42);
    }
    using db = openDatabase(path);
    const service = createRateLimitService(db, config(), () => NOW);
    expect(await service.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 42,
      dailyTokenBudget: 100_000,
      requestsToday: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid token reports cannot reduce or corrupt the budget counter", async () => {
  using db = openDatabase(":memory:");
  const service = createRateLimitService(db, config(), () => NOW);
  await service.recordTokenUsage(12);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(() => service.recordTokenUsage(invalid), RangeError, "non-negative safe integer");
  }
  expect((await service.getUsageStats()).dailyTokensUsed).toBe(12);
});
