/**
 * Storage Service
 *
 * Handles all Deno KV operations for persisting vote data.
 * Uses dependency injection pattern for testability.
 */

import {
  type AutonomousParticipationRecord,
  type ContextResetRecord,
  type DailyStats,
  isNewerHumanMessage,
  type PollRecord,
  type StorageService,
  type VoteRecord,
} from "../types/storage.ts";

// Re-exported for existing importers; the definitions live in src/types/storage.ts so that
// code ported to Bun can use them without importing this Deno KV implementation.
export { isNewerHumanMessage };
export type { ContextStorageService, StorageService } from "../types/storage.ts";

const MAX_PARTICIPATION_COMMIT_ATTEMPTS = 10;

/**
 * Creates a storage service backed by Deno KV.
 */
export function createStorageService(kv: Deno.Kv): StorageService {
  const getPreviousDate = (date: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    const value = new Date(Date.UTC(year, month - 1, day));
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().split("T")[0];
  };

  return {
    async recordVote(channelId, userId, userName, mood, date) {
      const record: VoteRecord = {
        channelId,
        odUserId: userId,
        odUserName: userName,
        mood,
        date,
        timestamp: Date.now(),
      };

      // Keep both indexes consistent. Stable keys make collection retries idempotent.
      const result = await kv
        .atomic()
        .set(["votes", channelId, date, userId], record)
        .set(["user_votes", channelId, userId, date], record)
        .commit();
      if (!result.ok) throw new Error("Could not persist vote and user history");
    },

    async getUserHistory(channelId, userId, limit = 30) {
      const records: VoteRecord[] = [];
      const iter = kv.list<VoteRecord>({
        prefix: ["user_votes", channelId, userId],
      });

      for await (const entry of iter) {
        records.push(entry.value);
      }

      // Sort by date descending (most recent first)
      records.sort((a, b) => b.date.localeCompare(a.date));

      return records.slice(0, limit);
    },

    async getVotesForDate(channelId, date) {
      const records: VoteRecord[] = [];
      const iter = kv.list<VoteRecord>({
        prefix: ["votes", channelId, date],
      });

      for await (const entry of iter) {
        records.push(entry.value);
      }

      return records;
    },

    async getStats(channelId, startDate, endDate) {
      const statsMap = new Map<string, DailyStats>();

      // Initialize all dates in range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const current = new Date(start);
      while (current <= end) {
        const dateStr = current.toISOString().split("T")[0];
        statsMap.set(dateStr, {
          date: dateStr,
          umazing: 0,
          ok: 0,
          glue: 0,
          total: 0,
        });
        current.setDate(current.getDate() + 1);
      }

      // Aggregate votes
      const iter = kv.list<VoteRecord>({ prefix: ["votes", channelId] });
      for await (const entry of iter) {
        const record = entry.value;
        if (record.date >= startDate && record.date <= endDate) {
          const stats = statsMap.get(record.date);
          if (stats) {
            stats[record.mood]++;
            stats.total++;
          }
        }
      }

      // Convert to array sorted by date
      return Array.from(statsMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    },

    async getConsecutiveGlueCount(channelId, userId) {
      const history = await this.getUserHistory(channelId, userId, 30);
      if (history.length === 0 || history[0].mood !== "glue") {
        return 0;
      }

      let count = 1;
      let expectedDate = getPreviousDate(history[0].date);

      for (const record of history.slice(1)) {
        if (record.mood !== "glue" || record.date !== expectedDate) {
          break;
        }

        count++;
        expectedDate = getPreviousDate(record.date);
      }

      return count;
    },

    async getUsersAtRisk(channelId, threshold) {
      // Get all unique user IDs
      const userIds = new Set<string>();
      const iter = kv.list<VoteRecord>({ prefix: ["user_votes", channelId] });

      for await (const entry of iter) {
        userIds.add(entry.value.odUserId);
      }

      // Check each user
      const atRisk: VoteRecord[][] = [];
      for (const userId of userIds) {
        const count = await this.getConsecutiveGlueCount(channelId, userId);
        if (count >= threshold) {
          const history = await this.getUserHistory(channelId, userId, count);
          atRisk.push(history);
        }
      }

      return atRisk;
    },

    async savePendingPoll(poll: PollRecord) {
      await kv.set(["pending_polls", poll.messageId], poll);
      console.log(`[STORAGE] Saved pending poll ${poll.messageId} for ${poll.date}`);
    },

    async getExpiredPolls() {
      const now = Date.now();
      const expired: PollRecord[] = [];
      const iter = kv.list<PollRecord>({ prefix: ["pending_polls"] });

      for await (const entry of iter) {
        const poll = entry.value;
        // Check if expired and not yet collected
        if (poll.expiresAt <= now && !poll.collected) {
          expired.push(poll);
        }
      }

      return expired;
    },

    async getAllPendingPolls() {
      const pending: PollRecord[] = [];
      const iter = kv.list<PollRecord>({ prefix: ["pending_polls"] });

      for await (const entry of iter) {
        if (!entry.value.collected) {
          pending.push(entry.value);
        }
      }

      return pending;
    },

    async markPollCollected(messageId: string) {
      const entry = await kv.get<PollRecord>(["pending_polls", messageId]);
      if (entry.value) {
        const updated: PollRecord = { ...entry.value, collected: true };
        await kv.set(["pending_polls", messageId], updated);
        console.log(`[STORAGE] Marked poll ${messageId} as collected`);
      }
    },

    async setContextReset(record) {
      await kv.set(["context_resets", record.channelId], record);
    },

    async getContextReset(channelId) {
      const entry = await kv.get<ContextResetRecord>(["context_resets", channelId]);
      return entry.value;
    },

    async getAutonomousParticipation(channelId) {
      const entry = await kv.get<AutonomousParticipationRecord>([
        "autonomous_participation",
        channelId,
      ]);
      return entry.value;
    },

    async claimAutonomousParticipation(record, cooldownMs) {
      if (
        !record.channelId ||
        !record.latestHumanMessageId ||
        !Number.isSafeInteger(record.attemptedAt) ||
        record.attemptedAt < 0 ||
        !Number.isSafeInteger(record.latestHumanTimestampMs) ||
        record.latestHumanTimestampMs < 0 ||
        !Number.isFinite(cooldownMs) ||
        cooldownMs < 0
      )
        throw new RangeError("Invalid autonomous participation attempt");

      const key = ["autonomous_participation", record.channelId];
      for (let attempt = 0; attempt < MAX_PARTICIPATION_COMMIT_ATTEMPTS; attempt++) {
        const entry = await kv.get<AutonomousParticipationRecord>(key);
        if (
          entry.value &&
          (!isNewerHumanMessage(record, entry.value) ||
            record.attemptedAt - entry.value.attemptedAt < cooldownMs)
        )
          return false;
        const preserved =
          entry.value?.lastReactionEmoji && !record.lastReactionEmoji
            ? { ...record, lastReactionEmoji: entry.value.lastReactionEmoji }
            : record;
        const result = await kv.atomic().check(entry).set(key, preserved).commit();
        if (result.ok) return true;
      }
      throw new Error("Autonomous participation transaction failed after repeated conflicts");
    },

    async finishAutonomousParticipation(
      channelId,
      latestHumanMessageId,
      finishedAt,
      reactionEmoji,
    ) {
      if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) {
        throw new RangeError("Invalid autonomous participation completion time");
      }
      const key = ["autonomous_participation", channelId];
      for (let attempt = 0; attempt < MAX_PARTICIPATION_COMMIT_ATTEMPTS; attempt++) {
        const entry = await kv.get<AutonomousParticipationRecord>(key);
        if (!entry.value || entry.value.latestHumanMessageId !== latestHumanMessageId) return;
        const attemptedAt = Math.max(entry.value.attemptedAt, finishedAt);
        if (
          attemptedAt === entry.value.attemptedAt &&
          (!reactionEmoji || reactionEmoji === entry.value.lastReactionEmoji)
        )
          return;
        const result = await kv
          .atomic()
          .check(entry)
          .set(key, {
            ...entry.value,
            attemptedAt,
            ...(reactionEmoji ? { lastReactionEmoji: reactionEmoji } : {}),
          })
          .commit();
        if (result.ok) return;
      }
      throw new Error("Autonomous participation completion failed after repeated conflicts");
    },
  };
}
