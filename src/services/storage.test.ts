/**
 * Storage Service Unit Tests
 *
 * Tests the SQLite storage operations using an in-memory database.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejects } from "../../tests/support/assert.ts";
import { type Database, openDatabase } from "../db/database.ts";
import { createStorageService, type StorageService } from "./storage.ts";
import type { AutonomousParticipationRecord, PollRecord } from "../types/storage.ts";

const TEST_CHANNEL_ID = "chan-1";
const OTHER_CHANNEL_ID = "chan-2";

// Helper to create a fresh storage service for each test
async function createTestStorage(): Promise<{ storage: StorageService; kv: Database }> {
  const kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  return { storage, kv };
}

// ============================================================================
// recordVote Tests
// ============================================================================

test("recordVote stores a vote correctly", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "umazing", "2025-12-10");

  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  expect(votes.length).toStrictEqual(1);
  expect(votes[0].channelId).toStrictEqual(TEST_CHANNEL_ID);
  expect(votes[0].odUserId).toStrictEqual("user123");
  expect(votes[0].odUserName).toStrictEqual("Alice");
  expect(votes[0].mood).toStrictEqual("umazing");
  expect(votes[0].date).toStrictEqual("2025-12-10");

  kv.close();
});

test("recordVote overwrites vote for same user on same date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "umazing", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-10");

  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  expect(votes.length).toStrictEqual(1);
  expect(votes[0].mood).toStrictEqual("glue"); // Should be updated

  kv.close();
});

test("recordVote stores multiple users on same date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user2", "Bob", "ok", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user3", "Charlie", "glue", "2025-12-10");

  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  expect(votes.length).toStrictEqual(3);

  kv.close();
});

test("recordVote isolates same user across channels", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-10");
  await storage.recordVote(OTHER_CHANNEL_ID, "user123", "Alice", "ok", "2025-12-10");

  const firstChannelVotes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  const secondChannelVotes = await storage.getVotesForDate(OTHER_CHANNEL_ID, "2025-12-10");

  expect(firstChannelVotes.length).toStrictEqual(1);
  expect(firstChannelVotes[0].mood).toStrictEqual("glue");
  expect(secondChannelVotes.length).toStrictEqual(1);
  expect(secondChannelVotes[0].mood).toStrictEqual("ok");

  kv.close();
});

test("context resets persist independently for each channel", async () => {
  const { storage, kv } = await createTestStorage();
  const first = { channelId: TEST_CHANNEL_ID, messageId: "reset-1", resetAt: 1000 };
  const second = { channelId: OTHER_CHANNEL_ID, messageId: "reset-2", resetAt: 2000 };

  await storage.setContextReset(first);
  await storage.setContextReset(second);

  expect(await storage.getContextReset(TEST_CHANNEL_ID)).toStrictEqual(first);
  expect(await storage.getContextReset(OTHER_CHANNEL_ID)).toStrictEqual(second);
  expect(await storage.getContextReset("unknown")).toStrictEqual(null);

  kv.close();
});

function createParticipation(
  overrides: Partial<AutonomousParticipationRecord> = {},
): AutonomousParticipationRecord {
  return {
    channelId: TEST_CHANNEL_ID,
    latestHumanMessageId: "1234567890123456789",
    latestHumanTimestampMs: 1000,
    attemptedAt: 2000,
    ...overrides,
  };
}

test("autonomous participation claims exactly once across concurrent services", async () => {
  using kv = openDatabase(":memory:");
  const first = createStorageService(kv);
  const second = createStorageService(kv);
  const record = createParticipation();
  const claims = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? first : second).claimAutonomousParticipation(record, 1000),
    ),
  );

  expect(claims.filter(Boolean).length).toStrictEqual(1);
  expect(await first.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(record);
});

test("autonomous participation persists across service recreation and isolates channels", async () => {
  using kv = openDatabase(":memory:");
  const first = createStorageService(kv);
  const record = createParticipation();
  expect(await first.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(null);
  expect(await first.claimAutonomousParticipation(record, 1000)).toStrictEqual(true);

  const restarted = createStorageService(kv);
  expect(await restarted.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(record);
  expect(
    await restarted.claimAutonomousParticipation({ ...record, attemptedAt: 10_000 }, 1000),
  ).toStrictEqual(false);
  const otherChannel = { ...record, channelId: OTHER_CHANNEL_ID };
  expect(await restarted.claimAutonomousParticipation(otherChannel, 1000)).toStrictEqual(true);
  expect(await restarted.getAutonomousParticipation(OTHER_CHANNEL_ID)).toStrictEqual(otherChannel);
  expect(await restarted.getAutonomousParticipation("unknown")).toStrictEqual(null);
});

test("autonomous participation rejects cooldown attempts without advancing the watermark", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  const next = createParticipation({
    latestHumanMessageId: "1234567890123456790",
    latestHumanTimestampMs: 1500,
    attemptedAt: 2999,
  });
  expect(await storage.claimAutonomousParticipation(first, 1000)).toStrictEqual(true);
  expect(await storage.claimAutonomousParticipation(next, 1000)).toStrictEqual(false);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(first);
  const atCooldownBoundary = { ...next, attemptedAt: 3000 };
  expect(await storage.claimAutonomousParticipation(atCooldownBoundary, 1000)).toStrictEqual(true);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(
    atCooldownBoundary,
  );

  const rows = kv
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM autonomous_participation")
    .get();
  expect(rows?.n).toBe(1);
});

test("autonomous participation rejects same messages, older context and reversed clocks", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  expect(await storage.claimAutonomousParticipation(first, 0)).toStrictEqual(true);
  for (const candidate of [
    { ...first, attemptedAt: 10_000 },
    { ...first, latestHumanTimestampMs: 1500, attemptedAt: 10_000 },
    {
      ...first,
      latestHumanMessageId: "1234567890123456790",
      latestHumanTimestampMs: 999,
      attemptedAt: 10_000,
    },
    {
      ...first,
      latestHumanMessageId: "1234567890123456790",
      latestHumanTimestampMs: 1500,
      attemptedAt: 1999,
    },
  ])
    expect(await storage.claimAutonomousParticipation(candidate, 0)).toStrictEqual(false);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(first);
});

test("autonomous participation orders equal timestamps by exact numeric snowflake", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  expect(await storage.claimAutonomousParticipation(first, 0)).toStrictEqual(true);
  expect(
    await storage.claimAutonomousParticipation(
      {
        ...first,
        latestHumanMessageId: "1234567890123456788",
        attemptedAt: 3000,
      },
      0,
    ),
  ).toStrictEqual(false);
  const newer = { ...first, latestHumanMessageId: "1234567890123456790", attemptedAt: 3000 };
  expect(await storage.claimAutonomousParticipation(newer, 0)).toStrictEqual(true);
  expect(await storage.claimAutonomousParticipation(first, 0)).toStrictEqual(false);
});

test("autonomous participation fails closed for equal timestamps with unordered IDs", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation({ latestHumanMessageId: "message-a" });
  expect(await storage.claimAutonomousParticipation(first, 0)).toStrictEqual(true);
  expect(
    await storage.claimAutonomousParticipation(
      {
        ...first,
        latestHumanMessageId: "message-b",
        attemptedAt: 3000,
      },
      0,
    ),
  ).toStrictEqual(false);
  expect(
    await storage.claimAutonomousParticipation(
      {
        ...first,
        latestHumanMessageId: "message-b",
        latestHumanTimestampMs: 1001,
        attemptedAt: 3000,
      },
      0,
    ),
  ).toStrictEqual(true);
});

test("autonomous participation survives reopening the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "haru-storage-"));
  try {
    const path = join(dir, "haru.sqlite3");
    const record = createParticipation({ lastReactionEmoji: "UwU:1" });
    {
      using db = openDatabase(path);
      expect(await createStorageService(db).claimAutonomousParticipation(record, 0)).toBe(true);
    }
    using db = openDatabase(path);
    const storage = createStorageService(db);
    expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(record);
    expect(await storage.claimAutonomousParticipation({ ...record, attemptedAt: 9000 }, 0)).toBe(
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autonomous participation rejects invalid times before writing", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const record = createParticipation();
  for (const cooldown of [-1, NaN, Infinity]) {
    await rejects(() => storage.claimAutonomousParticipation(record, cooldown), RangeError);
  }
  for (const invalid of [
    { ...record, channelId: "" },
    { ...record, latestHumanMessageId: "" },
    { ...record, attemptedAt: NaN },
    { ...record, latestHumanTimestampMs: -1 },
  ])
    await rejects(() => storage.claimAutonomousParticipation(invalid, 0), RangeError);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(null);
});

test("autonomous participation cooldown extends from generation completion", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation({ attemptedAt: 0 });
  expect(await storage.claimAutonomousParticipation(first, 60_000)).toStrictEqual(true);
  await storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 59_000);
  const next = createParticipation({
    latestHumanMessageId: "1234567890123456790",
    latestHumanTimestampMs: 60_000,
    attemptedAt: 60_000,
  });
  expect(await storage.claimAutonomousParticipation(next, 60_000)).toStrictEqual(false);
  expect(
    await storage.claimAutonomousParticipation({ ...next, attemptedAt: 119_000 }, 60_000),
  ).toStrictEqual(true);
});

test("autonomous participation completion never decreases time or changes another channel", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  const other = createParticipation({ channelId: OTHER_CHANNEL_ID });
  await storage.claimAutonomousParticipation(first, 0);
  await storage.claimAutonomousParticipation(other, 0);
  await storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 4000);
  await storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 3000);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual({
    ...first,
    attemptedAt: 4000,
  });
  expect(await storage.getAutonomousParticipation(OTHER_CHANNEL_ID)).toStrictEqual(other);
});

test("autonomous participation completion ignores absent and newer claims", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  await storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 10_000);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(null);
  const newer = createParticipation({ latestHumanMessageId: "1234567890123456790" });
  await storage.claimAutonomousParticipation(newer, 0);
  await storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 10_000);
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(newer);
});

test("a failed autonomous participation write keeps the earlier claim", async () => {
  using db = openDatabase(":memory:");
  const storage = createStorageService(db);
  const first = createParticipation();
  await storage.claimAutonomousParticipation(first, 0);
  db.run(`CREATE TRIGGER fail_participation BEFORE UPDATE ON autonomous_participation
          BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  await rejects(
    () => storage.finishAutonomousParticipation(TEST_CHANNEL_ID, first.latestHumanMessageId, 9000),
    Error,
    "simulated write failure",
  );
  const newer = createParticipation({
    latestHumanMessageId: "1234567890123456790",
    latestHumanTimestampMs: 3000,
    attemptedAt: 4000,
  });
  await rejects(() => storage.claimAutonomousParticipation(newer, 0), Error, "simulated");
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(first);
});

test("autonomous participation completion records a reaction without moving time back", async () => {
  using db = openDatabase(":memory:");
  const storage = createStorageService(db);
  const first = createParticipation({ attemptedAt: 5000 });
  await storage.claimAutonomousParticipation(first, 0);
  await storage.finishAutonomousParticipation(
    TEST_CHANNEL_ID,
    first.latestHumanMessageId,
    4000,
    "UwU:7",
  );
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual({
    ...first,
    lastReactionEmoji: "UwU:7",
  });
  const next = createParticipation({
    latestHumanMessageId: "1234567890123456790",
    latestHumanTimestampMs: 1500,
    attemptedAt: 6000,
  });
  expect(await storage.claimAutonomousParticipation(next, 0)).toBe(true);
  expect((await storage.getAutonomousParticipation(TEST_CHANNEL_ID))?.lastReactionEmoji).toBe(
    "UwU:7",
  );
});

test("autonomous participation completion rejects invalid times before writing", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  const first = createParticipation();
  await storage.claimAutonomousParticipation(first, 0);
  for (const finishedAt of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(
      () =>
        storage.finishAutonomousParticipation(
          TEST_CHANNEL_ID,
          first.latestHumanMessageId,
          finishedAt,
        ),
      RangeError,
    );
  }
  expect(await storage.getAutonomousParticipation(TEST_CHANNEL_ID)).toStrictEqual(first);
});

// ============================================================================
// getUserHistory Tests
// ============================================================================

test("getUserHistory returns empty array for unknown user", async () => {
  const { storage, kv } = await createTestStorage();

  const history = await storage.getUserHistory(TEST_CHANNEL_ID, "unknown");
  expect(history).toStrictEqual([]);

  kv.close();
});

test("getUserHistory returns votes sorted by date descending", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "umazing", "2025-12-08");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "ok", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-09");

  const history = await storage.getUserHistory(TEST_CHANNEL_ID, "user123");

  expect(history.length).toStrictEqual(3);
  expect(history[0].date).toStrictEqual("2025-12-10"); // Most recent first
  expect(history[1].date).toStrictEqual("2025-12-09");
  expect(history[2].date).toStrictEqual("2025-12-08");

  kv.close();
});

test("getUserHistory respects limit parameter", async () => {
  const { storage, kv } = await createTestStorage();

  // Add 10 votes
  for (let i = 1; i <= 10; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "ok", date);
  }

  const history = await storage.getUserHistory(TEST_CHANNEL_ID, "user123", 5);
  expect(history.length).toStrictEqual(5);

  kv.close();
});

// ============================================================================
// getVotesForDate Tests
// ============================================================================

test("getVotesForDate returns empty array for date with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  expect(votes).toStrictEqual([]);

  kv.close();
});

test("getVotesForDate returns all votes for a specific date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user2", "Bob", "ok", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user3", "Charlie", "glue", "2025-12-11"); // Different date

  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2025-12-10");
  expect(votes.length).toStrictEqual(2);

  kv.close();
});

// ============================================================================
// getStats Tests
// ============================================================================

test("getStats returns empty stats for date range with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const stats = await storage.getStats(TEST_CHANNEL_ID, "2025-12-01", "2025-12-03");

  expect(stats.length).toStrictEqual(3);
  expect(stats[0].total).toStrictEqual(0);
  expect(stats[1].total).toStrictEqual(0);
  expect(stats[2].total).toStrictEqual(0);

  kv.close();
});

test("getStats aggregates votes correctly", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user2", "Bob", "umazing", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user3", "Charlie", "ok", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user4", "Diana", "glue", "2025-12-10");

  const stats = await storage.getStats(TEST_CHANNEL_ID, "2025-12-10", "2025-12-10");

  expect(stats.length).toStrictEqual(1);
  expect(stats[0].umazing).toStrictEqual(2);
  expect(stats[0].ok).toStrictEqual(1);
  expect(stats[0].glue).toStrictEqual(1);
  expect(stats[0].total).toStrictEqual(4);

  kv.close();
});

test("getStats returns stats sorted by date ascending", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "umazing", "2025-12-12");
  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "ok", "2025-12-10");
  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "glue", "2025-12-11");

  const stats = await storage.getStats(TEST_CHANNEL_ID, "2025-12-10", "2025-12-12");

  expect(stats.length).toStrictEqual(3);
  expect(stats[0].date).toStrictEqual("2025-12-10");
  expect(stats[1].date).toStrictEqual("2025-12-11");
  expect(stats[2].date).toStrictEqual("2025-12-12");

  kv.close();
});

test("getStats lists each day once across a DST change in a non-UTC time zone", async () => {
  const savedTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const { storage, kv } = await createTestStorage();
    await storage.recordVote(TEST_CHANNEL_ID, "u1", "Alice", "ok", "2026-03-09");
    const stats = await storage.getStats(TEST_CHANNEL_ID, "2026-03-06", "2026-03-10");
    expect(stats.map((day) => day.date)).toStrictEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(stats[3].ok).toBe(1);
    kv.close();
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
});

test("getStats isolates channels", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user1", "Alice", "glue", "2025-12-10");
  await storage.recordVote(OTHER_CHANNEL_ID, "user1", "Alice", "umazing", "2025-12-10");

  const firstChannelStats = await storage.getStats(TEST_CHANNEL_ID, "2025-12-10", "2025-12-10");
  const secondChannelStats = await storage.getStats(OTHER_CHANNEL_ID, "2025-12-10", "2025-12-10");

  expect(firstChannelStats[0].glue).toStrictEqual(1);
  expect(firstChannelStats[0].umazing).toStrictEqual(0);
  expect(secondChannelStats[0].glue).toStrictEqual(0);
  expect(secondChannelStats[0].umazing).toStrictEqual(1);

  kv.close();
});

// ============================================================================
// getConsecutiveGlueCount Tests
// ============================================================================

test("getConsecutiveGlueCount returns 0 for user with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "unknown");
  expect(count).toStrictEqual(0);

  kv.close();
});

test("getConsecutiveGlueCount returns 0 when most recent is not glue", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-08");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-09");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "ok", "2025-12-10"); // Most recent

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  expect(count).toStrictEqual(0);

  kv.close();
});

test("getConsecutiveGlueCount counts consecutive glue votes from most recent", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "umazing", "2025-12-05");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-06");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-08");

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  expect(count).toStrictEqual(3); // 3 consecutive glue days

  kv.close();
});

test("getConsecutiveGlueCount stops at first non-glue vote", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-05");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "ok", "2025-12-06"); // Breaks streak
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-08");

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  expect(count).toStrictEqual(2); // Only 2 consecutive from most recent

  kv.close();
});

test("getConsecutiveGlueCount stops when there is a gap in vote dates", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-05");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-08");

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  expect(count).toStrictEqual(2); // 12-06 is missing, so 12-05 does not extend the streak

  kv.close();
});

test("getConsecutiveGlueCount returns 1 when most recent glue vote is stale", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-01");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-03");

  const count = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  expect(count).toStrictEqual(1);

  kv.close();
});

test("getConsecutiveGlueCount is channel scoped", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-08");
  await storage.recordVote(OTHER_CHANNEL_ID, "user123", "Alice", "ok", "2025-12-08");

  const firstChannelCount = await storage.getConsecutiveGlueCount(TEST_CHANNEL_ID, "user123");
  const secondChannelCount = await storage.getConsecutiveGlueCount(OTHER_CHANNEL_ID, "user123");

  expect(firstChannelCount).toStrictEqual(2);
  expect(secondChannelCount).toStrictEqual(0);

  kv.close();
});

// ============================================================================
// getUsersAtRisk Tests
// ============================================================================

test("getUsersAtRisk returns empty array when no users at risk", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "umazing", "2025-12-10");

  const atRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 7);
  expect(atRisk).toStrictEqual([]);

  kv.close();
});

test("getUsersAtRisk identifies user at threshold", async () => {
  const { storage, kv } = await createTestStorage();

  // Create 7 consecutive glue days for user
  for (let i = 1; i <= 7; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", date);
  }

  const atRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 7);
  expect(atRisk.length).toStrictEqual(1);
  expect(atRisk[0][0].odUserId).toStrictEqual("user123");

  kv.close();
});

test("getUsersAtRisk does not include users below threshold", async () => {
  const { storage, kv } = await createTestStorage();

  // Create only 5 consecutive glue days
  for (let i = 1; i <= 5; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", date);
  }

  const atRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 7);
  expect(atRisk).toStrictEqual([]);

  kv.close();
});

test("getUsersAtRisk identifies multiple users at risk", async () => {
  const { storage, kv } = await createTestStorage();

  // User 1: 7 glue days
  for (let i = 1; i <= 7; i++) {
    await storage.recordVote(
      TEST_CHANNEL_ID,
      "user1",
      "Alice",
      "glue",
      `2025-12-${i.toString().padStart(2, "0")}`,
    );
  }

  // User 2: 8 glue days
  for (let i = 1; i <= 8; i++) {
    await storage.recordVote(
      TEST_CHANNEL_ID,
      "user2",
      "Bob",
      "glue",
      `2025-12-${i.toString().padStart(2, "0")}`,
    );
  }

  // User 3: Only 3 glue days (not at risk)
  for (let i = 1; i <= 3; i++) {
    await storage.recordVote(
      TEST_CHANNEL_ID,
      "user3",
      "Charlie",
      "glue",
      `2025-12-${i.toString().padStart(2, "0")}`,
    );
  }

  const atRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 7);
  expect(atRisk.length).toStrictEqual(2);

  kv.close();
});

test("getUsersAtRisk excludes users whose glue votes are not on consecutive days", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-01");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-03");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-04");
  await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", "2025-12-05");

  const atRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 4);
  expect(atRisk).toStrictEqual([]);

  kv.close();
});

test("getUsersAtRisk is channel scoped", async () => {
  const { storage, kv } = await createTestStorage();

  for (let i = 1; i <= 7; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote(TEST_CHANNEL_ID, "user123", "Alice", "glue", date);
    await storage.recordVote(OTHER_CHANNEL_ID, "user123", "Alice", "ok", date);
  }

  const firstChannelAtRisk = await storage.getUsersAtRisk(TEST_CHANNEL_ID, 7);
  const secondChannelAtRisk = await storage.getUsersAtRisk(OTHER_CHANNEL_ID, 7);

  expect(firstChannelAtRisk.length).toStrictEqual(1);
  expect(secondChannelAtRisk).toStrictEqual([]);

  kv.close();
});

// ============================================================================
// Pending Poll Tests
// ============================================================================

function createPoll(overrides: Partial<PollRecord> = {}): PollRecord {
  const now = Date.now();
  return {
    messageId: "poll-1",
    channelId: "chan-1",
    date: "2025-12-10",
    createdAt: now - 1000,
    expiresAt: now + 1000,
    collected: false,
    ...overrides,
  };
}

test("savePendingPoll and getAllPendingPolls include uncollected polls only", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.savePendingPoll(createPoll({ messageId: "poll-a", collected: false }));
  await storage.savePendingPoll(createPoll({ messageId: "poll-b", collected: true }));

  const pending = await storage.getAllPendingPolls();
  expect(pending.length).toStrictEqual(1);
  expect(pending[0].messageId).toStrictEqual("poll-a");

  kv.close();
});

test("getExpiredPolls returns only expired and uncollected polls", async () => {
  const { storage, kv } = await createTestStorage();
  const now = Date.now();

  await storage.savePendingPoll(
    createPoll({
      messageId: "expired-open",
      expiresAt: now - 10,
      collected: false,
    }),
  );
  await storage.savePendingPoll(
    createPoll({
      messageId: "expired-collected",
      expiresAt: now - 10,
      collected: true,
    }),
  );
  await storage.savePendingPoll(
    createPoll({
      messageId: "future-open",
      expiresAt: now + 100000,
      collected: false,
    }),
  );

  const expired = await storage.getExpiredPolls();
  expect(expired.length).toStrictEqual(1);
  expect(expired[0].messageId).toStrictEqual("expired-open");

  kv.close();
});

test("markPollCollected updates existing poll and leaves missing poll unchanged", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.savePendingPoll(createPoll({ messageId: "poll-to-collect", collected: false }));
  await storage.markPollCollected("poll-to-collect");
  await storage.markPollCollected("does-not-exist");

  const row = kv
    .query<{ collected_at: number | null }, [string]>(
      "SELECT collected_at FROM polls WHERE message_id = ?",
    )
    .get("poll-to-collect");
  expect(row?.collected_at).toBeNumber();
  expect(await storage.getAllPendingPolls()).toStrictEqual([]);
  expect(kv.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM polls").get()?.n).toBe(1);

  kv.close();
});

test("a failed recordVote leaves no partial vote and supports retry", async () => {
  using db = openDatabase(":memory:");
  const storage = createStorageService(db);
  db.run(`CREATE TRIGGER fail_vote BEFORE INSERT ON votes
          BEGIN SELECT RAISE(ABORT, 'Injected disk failure'); END`);
  await rejects(
    () => storage.recordVote(TEST_CHANNEL_ID, "user", "Alice", "ok", "2026-09-01"),
    Error,
    "Injected disk failure",
  );
  expect(await storage.getVotesForDate(TEST_CHANNEL_ID, "2026-09-01")).toStrictEqual([]);
  expect(await storage.getUserHistory(TEST_CHANNEL_ID, "user")).toStrictEqual([]);

  db.run("DROP TRIGGER fail_vote");
  await storage.recordVote(TEST_CHANNEL_ID, "user", "Alice", "ok", "2026-09-01");
  const votes = await storage.getVotesForDate(TEST_CHANNEL_ID, "2026-09-01");
  expect(votes.length).toBe(1);
  expect(await storage.getUserHistory(TEST_CHANNEL_ID, "user")).toStrictEqual(votes);
});

test("savePendingPoll overwrites an existing poll, including its collected state", async () => {
  using db = openDatabase(":memory:");
  const storage = createStorageService(db, () => 5000);
  await storage.savePendingPoll(createPoll({ messageId: "poll", expiresAt: 1000 }));
  await storage.markPollCollected("poll");
  expect(await storage.getAllPendingPolls()).toStrictEqual([]);
  const replaced = createPoll({ messageId: "poll", channelId: "chan-9", expiresAt: 4000 });
  await storage.savePendingPoll(replaced);
  expect(await storage.getAllPendingPolls()).toStrictEqual([replaced]);
  expect(await storage.getExpiredPolls()).toStrictEqual([replaced]);
});

test("last delivered expression survives claims, silence, and storage recreation", async () => {
  const kv = openDatabase(":memory:");
  try {
    let storage = createStorageService(kv);
    const first = {
      channelId: "channel",
      latestHumanMessageId: "100",
      latestHumanTimestampMs: 1000,
      attemptedAt: 2000,
    };
    expect(await storage.claimAutonomousParticipation(first, 0)).toStrictEqual(true);
    await storage.finishAutonomousParticipation("channel", "100", 2000, "UwU:123");
    storage = createStorageService(kv);
    expect((await storage.getAutonomousParticipation("channel"))?.lastReactionEmoji).toStrictEqual(
      "UwU:123",
    );
    expect(
      await storage.claimAutonomousParticipation(
        {
          ...first,
          latestHumanMessageId: "101",
          latestHumanTimestampMs: 3000,
          attemptedAt: 4000,
        },
        0,
      ),
    ).toStrictEqual(true);
    await storage.finishAutonomousParticipation("channel", "101", 5000);
    expect((await storage.getAutonomousParticipation("channel"))?.lastReactionEmoji).toStrictEqual(
      "UwU:123",
    );
    await storage.finishAutonomousParticipation("channel", "100", 6000, "Wrong:456");
    expect((await storage.getAutonomousParticipation("channel"))?.lastReactionEmoji).toStrictEqual(
      "UwU:123",
    );
  } finally {
    kv.close();
  }
});
