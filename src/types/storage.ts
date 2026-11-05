/**
 * Storage Types
 *
 * Types for persisted data and the storage service interface.
 */

import type { Mood } from "./bot.ts";

/** A single vote record from a user */
export interface VoteRecord {
  channelId: string;
  odUserId: string;
  odUserName: string;
  mood: Mood;
  date: string; // ISO date string "YYYY-MM-DD"
  timestamp: number;
}

/** Aggregated stats for a single day */
export interface DailyStats {
  date: string;
  umazing: number;
  ok: number;
  glue: number;
  total: number;
}

/** A pending poll waiting for results collection */
export interface PollRecord {
  messageId: string;
  channelId: string;
  date: string; // The date this poll is for (YYYY-MM-DD)
  createdAt: number; // Timestamp when poll was created
  expiresAt: number; // Timestamp when poll expires (createdAt + 24h)
  collected: boolean; // Whether results have been collected
}

/** Durable cutoff that prevents Discord history from reviving cleared context. */
export interface ContextResetRecord {
  channelId: string;
  messageId: string;
  resetAt: number;
}

/** Latest autonomous attempt, including silent decisions and failed Discord writes. */
export interface AutonomousParticipationRecord {
  channelId: string;
  latestHumanMessageId: string;
  attemptedAt: number;
  latestHumanTimestampMs: number;
  lastReactionEmoji?: string;
}

/** Storage service interface for dependency injection */
export interface StorageService {
  /** Record a user's vote */
  recordVote(
    channelId: string,
    userId: string,
    userName: string,
    mood: Mood,
    date: string,
  ): Promise<void>;

  /** Get a user's vote history (most recent first) */
  getUserHistory(channelId: string, userId: string, limit?: number): Promise<VoteRecord[]>;

  /** Get aggregated stats for a date range */
  getStats(channelId: string, startDate: string, endDate: string): Promise<DailyStats[]>;

  /** Get all votes for a specific date */
  getVotesForDate(channelId: string, date: string): Promise<VoteRecord[]>;

  /** Check if a user has consecutive "glue" votes */
  getConsecutiveGlueCount(channelId: string, userId: string): Promise<number>;

  /** Get all users who have hit the glue threshold */
  getUsersAtRisk(channelId: string, threshold: number): Promise<VoteRecord[][]>;

  /** Save a pending poll for later result collection */
  savePendingPoll(poll: PollRecord): Promise<void>;

  /** Get all polls that have expired but not yet collected */
  getExpiredPolls(): Promise<PollRecord[]>;

  /** Get all pending polls (not yet collected) */
  getAllPendingPolls(): Promise<PollRecord[]>;

  /** Mark a poll as collected */
  markPollCollected(messageId: string): Promise<void>;

  /** Persist the latest context reset for one Discord channel or thread. */
  setContextReset(record: ContextResetRecord): Promise<void>;

  /** Read the latest context reset for one Discord channel or thread. */
  getContextReset(channelId: string): Promise<ContextResetRecord | null>;

  /** Read the latest autonomous attempt for one Discord channel or thread. */
  getAutonomousParticipation(channelId: string): Promise<AutonomousParticipationRecord | null>;

  /** Atomically consume a new human message watermark and the channel cooldown. */
  claimAutonomousParticipation(
    record: AutonomousParticipationRecord,
    cooldownMs: number,
  ): Promise<boolean>;

  /** Extend cooldown from completion without replacing a newer message claim. */
  finishAutonomousParticipation(
    channelId: string,
    latestHumanMessageId: string,
    finishedAt: number,
    reactionEmoji?: string,
  ): Promise<void>;
}

export type ContextStorageService = Pick<StorageService, "setContextReset" | "getContextReset">;

/** Fail closed when equal timestamps cannot establish a newer Discord message. */
export function isNewerHumanMessage(
  candidate: Pick<AutonomousParticipationRecord, "latestHumanMessageId" | "latestHumanTimestampMs">,
  previous: Pick<AutonomousParticipationRecord, "latestHumanMessageId" | "latestHumanTimestampMs">,
): boolean {
  if (candidate.latestHumanMessageId === previous.latestHumanMessageId) return false;
  if (candidate.latestHumanTimestampMs !== previous.latestHumanTimestampMs) {
    return candidate.latestHumanTimestampMs > previous.latestHumanTimestampMs;
  }
  if (!/^\d+$/.test(candidate.latestHumanMessageId) || !/^\d+$/.test(previous.latestHumanMessageId))
    return false;
  return BigInt(candidate.latestHumanMessageId) > BigInt(previous.latestHumanMessageId);
}
