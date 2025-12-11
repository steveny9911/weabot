/**
 * Storage Types
 *
 * Types for persisted data in Deno KV.
 */

import type { Mood } from "./bot.ts";

/** A single vote record from a user */
export interface VoteRecord {
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
