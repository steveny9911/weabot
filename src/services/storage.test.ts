/**
 * Storage Service Unit Tests
 *
 * Tests the Deno KV storage operations using an in-memory database.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { createStorageService, type StorageService } from "./storage.ts";

// Helper to create a fresh storage service for each test
async function createTestStorage(): Promise<{ storage: StorageService; kv: Deno.Kv }> {
  const kv = await Deno.openKv(":memory:");
  const storage = createStorageService(kv);
  return { storage, kv };
}

// ============================================================================
// recordVote Tests
// ============================================================================

Deno.test("recordVote stores a vote correctly", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "umazing", "2025-12-10");

  const votes = await storage.getVotesForDate("2025-12-10");
  assertEquals(votes.length, 1);
  assertEquals(votes[0].odUserId, "user123");
  assertEquals(votes[0].odUserName, "Alice");
  assertEquals(votes[0].mood, "umazing");
  assertEquals(votes[0].date, "2025-12-10");

  kv.close();
});

Deno.test("recordVote overwrites vote for same user on same date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "umazing", "2025-12-10");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-10");

  const votes = await storage.getVotesForDate("2025-12-10");
  assertEquals(votes.length, 1);
  assertEquals(votes[0].mood, "glue"); // Should be updated

  kv.close();
});

Deno.test("recordVote stores multiple users on same date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote("user2", "Bob", "ok", "2025-12-10");
  await storage.recordVote("user3", "Charlie", "glue", "2025-12-10");

  const votes = await storage.getVotesForDate("2025-12-10");
  assertEquals(votes.length, 3);

  kv.close();
});

// ============================================================================
// getUserHistory Tests
// ============================================================================

Deno.test("getUserHistory returns empty array for unknown user", async () => {
  const { storage, kv } = await createTestStorage();

  const history = await storage.getUserHistory("unknown");
  assertEquals(history, []);

  kv.close();
});

Deno.test("getUserHistory returns votes sorted by date descending", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "umazing", "2025-12-08");
  await storage.recordVote("user123", "Alice", "ok", "2025-12-10");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-09");

  const history = await storage.getUserHistory("user123");

  assertEquals(history.length, 3);
  assertEquals(history[0].date, "2025-12-10"); // Most recent first
  assertEquals(history[1].date, "2025-12-09");
  assertEquals(history[2].date, "2025-12-08");

  kv.close();
});

Deno.test("getUserHistory respects limit parameter", async () => {
  const { storage, kv } = await createTestStorage();

  // Add 10 votes
  for (let i = 1; i <= 10; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote("user123", "Alice", "ok", date);
  }

  const history = await storage.getUserHistory("user123", 5);
  assertEquals(history.length, 5);

  kv.close();
});

// ============================================================================
// getVotesForDate Tests
// ============================================================================

Deno.test("getVotesForDate returns empty array for date with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const votes = await storage.getVotesForDate("2025-12-10");
  assertEquals(votes, []);

  kv.close();
});

Deno.test("getVotesForDate returns all votes for a specific date", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote("user2", "Bob", "ok", "2025-12-10");
  await storage.recordVote("user3", "Charlie", "glue", "2025-12-11"); // Different date

  const votes = await storage.getVotesForDate("2025-12-10");
  assertEquals(votes.length, 2);

  kv.close();
});

// ============================================================================
// getStats Tests
// ============================================================================

Deno.test("getStats returns empty stats for date range with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const stats = await storage.getStats("2025-12-01", "2025-12-03");

  assertEquals(stats.length, 3);
  assertEquals(stats[0].total, 0);
  assertEquals(stats[1].total, 0);
  assertEquals(stats[2].total, 0);

  kv.close();
});

Deno.test("getStats aggregates votes correctly", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user1", "Alice", "umazing", "2025-12-10");
  await storage.recordVote("user2", "Bob", "umazing", "2025-12-10");
  await storage.recordVote("user3", "Charlie", "ok", "2025-12-10");
  await storage.recordVote("user4", "Diana", "glue", "2025-12-10");

  const stats = await storage.getStats("2025-12-10", "2025-12-10");

  assertEquals(stats.length, 1);
  assertEquals(stats[0].umazing, 2);
  assertEquals(stats[0].ok, 1);
  assertEquals(stats[0].glue, 1);
  assertEquals(stats[0].total, 4);

  kv.close();
});

Deno.test("getStats returns stats sorted by date ascending", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user1", "Alice", "umazing", "2025-12-12");
  await storage.recordVote("user1", "Alice", "ok", "2025-12-10");
  await storage.recordVote("user1", "Alice", "glue", "2025-12-11");

  const stats = await storage.getStats("2025-12-10", "2025-12-12");

  assertEquals(stats.length, 3);
  assertEquals(stats[0].date, "2025-12-10");
  assertEquals(stats[1].date, "2025-12-11");
  assertEquals(stats[2].date, "2025-12-12");

  kv.close();
});

// ============================================================================
// getConsecutiveGlueCount Tests
// ============================================================================

Deno.test("getConsecutiveGlueCount returns 0 for user with no votes", async () => {
  const { storage, kv } = await createTestStorage();

  const count = await storage.getConsecutiveGlueCount("unknown");
  assertEquals(count, 0);

  kv.close();
});

Deno.test("getConsecutiveGlueCount returns 0 when most recent is not glue", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "glue", "2025-12-08");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-09");
  await storage.recordVote("user123", "Alice", "ok", "2025-12-10"); // Most recent

  const count = await storage.getConsecutiveGlueCount("user123");
  assertEquals(count, 0);

  kv.close();
});

Deno.test("getConsecutiveGlueCount counts consecutive glue votes from most recent", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "umazing", "2025-12-05");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-06");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-08");

  const count = await storage.getConsecutiveGlueCount("user123");
  assertEquals(count, 3); // 3 consecutive glue days

  kv.close();
});

Deno.test("getConsecutiveGlueCount stops at first non-glue vote", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "glue", "2025-12-05");
  await storage.recordVote("user123", "Alice", "ok", "2025-12-06"); // Breaks streak
  await storage.recordVote("user123", "Alice", "glue", "2025-12-07");
  await storage.recordVote("user123", "Alice", "glue", "2025-12-08");

  const count = await storage.getConsecutiveGlueCount("user123");
  assertEquals(count, 2); // Only 2 consecutive from most recent

  kv.close();
});

// ============================================================================
// getUsersAtRisk Tests
// ============================================================================

Deno.test("getUsersAtRisk returns empty array when no users at risk", async () => {
  const { storage, kv } = await createTestStorage();

  await storage.recordVote("user123", "Alice", "umazing", "2025-12-10");

  const atRisk = await storage.getUsersAtRisk(7);
  assertEquals(atRisk, []);

  kv.close();
});

Deno.test("getUsersAtRisk identifies user at threshold", async () => {
  const { storage, kv } = await createTestStorage();

  // Create 7 consecutive glue days for user
  for (let i = 1; i <= 7; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote("user123", "Alice", "glue", date);
  }

  const atRisk = await storage.getUsersAtRisk(7);
  assertEquals(atRisk.length, 1);
  assertEquals(atRisk[0][0].odUserId, "user123");

  kv.close();
});

Deno.test("getUsersAtRisk does not include users below threshold", async () => {
  const { storage, kv } = await createTestStorage();

  // Create only 5 consecutive glue days
  for (let i = 1; i <= 5; i++) {
    const date = `2025-12-${i.toString().padStart(2, "0")}`;
    await storage.recordVote("user123", "Alice", "glue", date);
  }

  const atRisk = await storage.getUsersAtRisk(7);
  assertEquals(atRisk, []);

  kv.close();
});

Deno.test("getUsersAtRisk identifies multiple users at risk", async () => {
  const { storage, kv } = await createTestStorage();

  // User 1: 7 glue days
  for (let i = 1; i <= 7; i++) {
    await storage.recordVote("user1", "Alice", "glue", `2025-12-${i.toString().padStart(2, "0")}`);
  }

  // User 2: 8 glue days
  for (let i = 1; i <= 8; i++) {
    await storage.recordVote("user2", "Bob", "glue", `2025-12-${i.toString().padStart(2, "0")}`);
  }

  // User 3: Only 3 glue days (not at risk)
  for (let i = 1; i <= 3; i++) {
    await storage.recordVote(
      "user3",
      "Charlie",
      "glue",
      `2025-12-${i.toString().padStart(2, "0")}`,
    );
  }

  const atRisk = await storage.getUsersAtRisk(7);
  assertEquals(atRisk.length, 2);

  kv.close();
});
