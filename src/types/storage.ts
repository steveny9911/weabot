/**
 * Storage Types
 *
 * Types for persisted data in Deno KV.
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

/** Alert configuration */
export interface AlertConfig {
  consecutiveGlueThreshold: number; // Default: 7
  alertChannelId?: string; // Optional: separate channel for alerts
}

/** Default alert configuration */
export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  consecutiveGlueThreshold: 7,
};

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
