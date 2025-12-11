/**
 * Storage Service
 *
 * Handles all Deno KV operations for persisting vote data.
 * Uses dependency injection pattern for testability.
 */

import type { Mood } from "../types/bot.ts";
import type { DailyStats, VoteRecord } from "../types/storage.ts";

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
}

/**
 * Creates a storage service backed by Deno KV.
 */
export function createStorageService(kv: Deno.Kv): StorageService {
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
      let count = 0;

      for (const record of history) {
        if (record.mood === "glue") {
          count++;
        } else {
          break; // Stop at first non-glue
        }
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
          const history = await this.getUserHistory(userId, threshold);
          atRisk.push(history);
        }
      }

      return atRisk;
    },
  };
}
