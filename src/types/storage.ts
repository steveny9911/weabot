import type { Mood } from "./bot.ts";

export interface VoteRecord {
  channelId: string;
  userId: string;
  userName: string;
  mood: Mood;
  date: string; // ISO date string "YYYY-MM-DD"
  timestamp: number;
}

export interface DailyStats {
  date: string;
  umazing: number;
  ok: number;
  glue: number;
  total: number;
}

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
