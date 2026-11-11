/** Votes, polls, context resets and autonomous participation, stored in SQLite. */

import type { Database } from "bun:sqlite";
import { createChatStateQueries } from "../db/chat_state.ts";
import { createVoteQueries } from "../db/votes.ts";
import type { Mood } from "../types/bot.ts";
import type {
  AutonomousParticipationRecord,
  ContextResetRecord,
  DailyStats,
  PollRecord,
  VoteRecord,
} from "../types/storage.ts";

export type StorageService = ReturnType<typeof createStorageService>;
export type ContextStorageService = Pick<StorageService, "setContextReset" | "getContextReset">;

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** How many of the latest votes, newest first, are "glue" on consecutive days. */
function glueStreak(history: VoteRecord[]): number {
  let count = 0;
  let expectedDate = history[0]?.date;
  for (const record of history) {
    if (record.mood !== "glue" || record.date !== expectedDate) break;
    count++;
    expectedDate = previousDate(record.date);
  }
  return count;
}

export function createStorageService(db: Database, now: () => number = Date.now) {
  const votes = createVoteQueries(db);
  const chat = createChatStateQueries(db);

  return {
    async recordVote(
      channelId: string,
      userId: string,
      userName: string,
      mood: Mood,
      date: string,
    ) {
      votes.recordVote({ channelId, userId, userName, mood, date, timestamp: now() });
    },

    /** Most recent first. */
    async getUserHistory(channelId: string, userId: string, limit = 30) {
      return votes.userHistory(channelId, userId, limit);
    },

    async getVotesForDate(channelId: string, date: string) {
      return votes.votesForDate(channelId, date);
    },

    /** One entry per UTC day from `startDate` to `endDate`, both included. */
    async getStats(channelId: string, startDate: string, endDate: string) {
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

    /** Consecutive "glue" days, counting back from the user's latest vote. */
    async getConsecutiveGlueCount(channelId: string, userId: string) {
      return glueStreak(votes.userHistory(channelId, userId, 30));
    },

    /** The glue streak of each user with at least `threshold` consecutive "glue" days. */
    async getUsersAtRisk(channelId: string, threshold: number) {
      const atRisk: VoteRecord[][] = [];
      for (const userId of votes.voters(channelId)) {
        const history = votes.userHistory(channelId, userId, 30);
        const count = glueStreak(history);
        if (count >= threshold) atRisk.push(history.slice(0, count));
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

    /** The latest context reset of a channel or thread; history before it is never context. */
    async setContextReset(record: ContextResetRecord) {
      chat.setContextReset(record);
    },

    async getContextReset(channelId: string) {
      return chat.getContextReset(channelId);
    },

    /** The latest autonomous attempt in a channel or thread. */
    async getAutonomousParticipation(channelId: string) {
      return chat.getParticipation(channelId);
    },

    /** Atomically consumes a newer human message watermark and the channel cooldown. */
    async claimAutonomousParticipation(record: AutonomousParticipationRecord, cooldownMs: number) {
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

    /** Extends the cooldown from completion without replacing a newer message claim. */
    async finishAutonomousParticipation(
      channelId: string,
      latestHumanMessageId: string,
      finishedAt: number,
      reactionEmoji?: string,
    ) {
      if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) {
        throw new RangeError("Invalid autonomous participation completion time");
      }
      chat.finishParticipation(channelId, latestHumanMessageId, finishedAt, reactionEmoji);
    },
  };
}
