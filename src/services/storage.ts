/**
 * Storage Service
 *
 * Handles all Deno KV operations for persisting vote data.
 * Uses dependency injection pattern for testability.
 */

import type { Mood } from "../types/bot.ts";
import type { DailyStats, PollRecord, VoteRecord } from "../types/storage.ts";

/** Storage service interface for dependency injection */
export interface StorageService {
  /** Record a user's vote */
  recordVote(
    userId: string,
    userName: string,
    mood: Mood,
    date: string,
  ): Promise<void>;

  /** Get a user's vote history (most recent first) */
  getUserHistory(userId: string, limit?: number): Promise<VoteRecord[]>;

  /** Get aggregated stats for a date range */
  getStats(startDate: string, endDate: string): Promise<DailyStats[]>;

  /** Get all votes for a specific date */
  getVotesForDate(date: string): Promise<VoteRecord[]>;

  /** Check if a user has consecutive "glue" votes */
  getConsecutiveGlueCount(userId: string): Promise<number>;

  /** Get all users who have hit the glue threshold */
  getUsersAtRisk(threshold: number): Promise<VoteRecord[][]>;

  /** Save a pending poll for later result collection */
  savePendingPoll(poll: PollRecord): Promise<void>;

  /** Get all polls that have expired but not yet collected */
  getExpiredPolls(): Promise<PollRecord[]>;

  /** Get all pending polls (not yet collected) */
  getAllPendingPolls(): Promise<PollRecord[]>;

  /** Mark a poll as collected */
  markPollCollected(messageId: string): Promise<void>;
}

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
    async recordVote(userId, userName, mood, date) {
      const record: VoteRecord = {
        odUserId: userId,
        odUserName: userName,
        mood,
        date,
        timestamp: Date.now(),
      };

      // Store by date and user (for daily lookups)
      await kv.set(["votes", date, userId], record);

      // Store in user's history (for consecutive checks)
      await kv.set(["user_votes", userId, date], record);
    },

    async getUserHistory(userId, limit = 30) {
      const records: VoteRecord[] = [];
      const iter = kv.list<VoteRecord>({
        prefix: ["user_votes", userId],
      });

      for await (const entry of iter) {
        records.push(entry.value);
      }

      // Sort by date descending (most recent first)
      records.sort((a, b) => b.date.localeCompare(a.date));

      return records.slice(0, limit);
    },

    async getVotesForDate(date) {
      const records: VoteRecord[] = [];
      const iter = kv.list<VoteRecord>({
        prefix: ["votes", date],
      });

      for await (const entry of iter) {
        records.push(entry.value);
      }

      return records;
    },

    async getStats(startDate, endDate) {
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
      const iter = kv.list<VoteRecord>({ prefix: ["votes"] });
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

    async getConsecutiveGlueCount(userId) {
      const history = await this.getUserHistory(userId, 30);
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

    async getUsersAtRisk(threshold) {
      // Get all unique user IDs
      const userIds = new Set<string>();
      const iter = kv.list<VoteRecord>({ prefix: ["user_votes"] });

      for await (const entry of iter) {
        userIds.add(entry.value.odUserId);
      }

      // Check each user
      const atRisk: VoteRecord[][] = [];
      for (const userId of userIds) {
        const count = await this.getConsecutiveGlueCount(userId);
        if (count >= threshold) {
          const history = await this.getUserHistory(userId, count);
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
  };
}
