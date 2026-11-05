/**
 * Storage Service
 *
 * Persists votes, polls, context resets and autonomous participation in SQLite.
 * Uses dependency injection pattern for testability.
 */

import type { Database } from "bun:sqlite";
import { createChatStateQueries } from "../db/chat_state.ts";
import { createVoteQueries } from "../db/votes.ts";
import {
  type DailyStats,
  isNewerHumanMessage,
  type PollRecord,
  type StorageService,
} from "../types/storage.ts";

// Re-exported for existing importers; the definitions live in src/types/storage.ts.
export { isNewerHumanMessage };
export type { ContextStorageService, StorageService } from "../types/storage.ts";

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/**
 * Creates a storage service backed by the shared SQLite database.
 */
export function createStorageService(db: Database, now: () => number = Date.now): StorageService {
  const votes = createVoteQueries(db);
  const chat = createChatStateQueries(db);

  return {
    async recordVote(channelId, userId, userName, mood, date) {
      votes.recordVote({
        channelId,
        odUserId: userId,
        odUserName: userName,
        mood,
        date,
        timestamp: now(),
      });
    },

    async getUserHistory(channelId, userId, limit = 30) {
      return votes.userHistory(channelId, userId, limit);
    },

    async getVotesForDate(channelId, date) {
      return votes.votesForDate(channelId, date);
    },

    async getStats(channelId, startDate, endDate) {
      const stats = new Map<string, DailyStats>();
      // Every day in the range, stepping in UTC so a DST change cannot skip or repeat a day.
      const current = new Date(startDate);
      const end = new Date(endDate);
      while (current <= end) {
        const date = current.toISOString().slice(0, 10);
        stats.set(date, { date, umazing: 0, ok: 0, glue: 0, total: 0 });
        current.setUTCDate(current.getUTCDate() + 1);
      }
      for (const row of votes.moodCounts(channelId, startDate, endDate)) {
        const day = stats.get(row.vote_date);
        if (!day) continue;
        day[row.mood] += row.count;
        day.total += row.count;
      }
      return [...stats.values()];
    },

    async getConsecutiveGlueCount(channelId, userId) {
      const history = votes.userHistory(channelId, userId, 30);
      if (history.length === 0 || history[0].mood !== "glue") return 0;

      let count = 1;
      let expectedDate = previousDate(history[0].date);
      for (const record of history.slice(1)) {
        if (record.mood !== "glue" || record.date !== expectedDate) break;
        count++;
        expectedDate = previousDate(record.date);
      }
      return count;
    },

    async getUsersAtRisk(channelId, threshold) {
      const atRisk = [];
      for (const userId of votes.voters(channelId)) {
        const count = await this.getConsecutiveGlueCount(channelId, userId);
        if (count >= threshold) atRisk.push(votes.userHistory(channelId, userId, count));
      }
      return atRisk;
    },

    async savePendingPoll(poll: PollRecord) {
      votes.savePoll(poll, now());
      console.log(`[STORAGE] Saved pending poll ${poll.messageId} for ${poll.date}`);
    },

    async getExpiredPolls() {
      return votes.expiredPolls(now());
    },

    async getAllPendingPolls() {
      return votes.pendingPolls();
    },

    async markPollCollected(messageId: string) {
      if (votes.markCollected(messageId, now())) {
        console.log(`[STORAGE] Marked poll ${messageId} as collected`);
      }
    },

    async setContextReset(record) {
      chat.setContextReset(record);
    },

    async getContextReset(channelId) {
      return chat.getContextReset(channelId);
    },

    async getAutonomousParticipation(channelId) {
      return chat.getParticipation(channelId);
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
      return chat.claimParticipation(record, cooldownMs);
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
      chat.finishParticipation(channelId, latestHumanMessageId, finishedAt, reactionEmoji);
    },
  };
}
