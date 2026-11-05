/**
 * Persistent AI usage counters and atomic request admission.
 *
 * The daily budget is a soft threshold on reported usage: admitted requests may
 * finish above it. It is not a reservation or a strict cap on in-flight tokens.
 */

import { type Database, SQLiteError } from "bun:sqlite";
import type { AppConfig } from "../config.ts";
import { createAiUsageQueries } from "../db/ai_usage.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export type RequestAdmission = RateLimitResult &
  ({ allowed: true } | { allowed: false; reason: "user_limit" | "daily_budget" });

export interface BudgetResult {
  allowed: boolean;
  tokensRemaining: number;
}

export interface UsageStats {
  dailyTokensUsed: number;
  dailyTokenBudget: number;
  requestsToday: number;
}

export interface RateLimitService {
  /** Atomically check limits and count one accepted request. */
  admitRequest(userId: string, options?: { enforceUserLimit?: boolean }): Promise<RequestAdmission>;
  /** Read-only snapshot; use admitRequest to authorize generation. */
  checkUserRateLimit(userId: string): Promise<RateLimitResult>;
  /** Unconditionally count a request, without authorizing it. */
  recordUserRequest(userId: string): Promise<void>;
  /** Read-only soft budget snapshot, excluding unreported in-flight usage. */
  checkDailyBudget(): Promise<BudgetResult>;
  /** Record reported tokens in the UTC day when this method is called. */
  recordTokenUsage(tokens: number): Promise<void>;
  getUsageStats(): Promise<UsageStats>;
}

/**
 * Per-user request counts live in memory for the current UTC minute (a restart resets them,
 * behavior change 2). Daily request and token totals are stored in SQLite.
 *
 * `bun:sqlite` is synchronous and nothing below awaits between reading and writing, so admission
 * cannot interleave with another admission or a token report.
 */
export function createRateLimitService(
  db: Database,
  config: AppConfig,
  now: () => number = Date.now,
): RateLimitService {
  const usage = createAiUsageQueries(db);
  // One entry per user; an entry from an earlier minute is replaced on the next admission.
  const minuteCounts = new Map<string, { minute: string; count: number }>();

  function bucket(time = now()) {
    const iso = new Date(time).toISOString();
    return {
      minute: iso.slice(0, 16),
      date: iso.slice(0, 10),
      resetInMs: 60_000 - (time % 60_000),
    };
  }

  function userCount(userId: string, minute: string): number {
    const entry = minuteCounts.get(userId);
    return entry?.minute === minute ? entry.count : 0;
  }

  const admit = db.transaction(
    (userId: string, enforceBudget: boolean, enforceUserLimit: boolean): RequestAdmission => {
      const current = bucket();
      const count = userCount(userId, current.minute);
      const result = {
        remaining: Math.max(0, config.aiRateLimitPerUser - count),
        resetInMs: current.resetInMs,
      };
      if (enforceUserLimit && count >= config.aiRateLimitPerUser) {
        return { ...result, allowed: false, reason: "user_limit" };
      }
      if (enforceBudget && usage.get(current.date).tokens >= config.aiDailyTokenBudget) {
        return { ...result, allowed: false, reason: "daily_budget" };
      }
      usage.addRequest(current.date);
      minuteCounts.set(userId, { minute: current.minute, count: count + 1 });
      return { ...result, allowed: true, remaining: Math.max(0, result.remaining - 1) };
    },
  );

  return {
    async admitRequest(userId, options) {
      return admit.immediate(userId, true, options?.enforceUserLimit ?? true);
    },

    async checkUserRateLimit(userId) {
      const current = bucket();
      const count = userCount(userId, current.minute);
      return {
        allowed: count < config.aiRateLimitPerUser,
        remaining: Math.max(0, config.aiRateLimitPerUser - count),
        resetInMs: current.resetInMs,
      };
    },

    async recordUserRequest(userId) {
      admit.immediate(userId, false, false);
    },

    async checkDailyBudget() {
      const used = usage.get(bucket().date).tokens;
      return {
        allowed: used < config.aiDailyTokenBudget,
        tokensRemaining: Math.max(0, config.aiDailyTokenBudget - used),
      };
    },

    async recordTokenUsage(tokens) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new RangeError("Reported token usage must be a non-negative safe integer");
      }
      const date = bucket().date;
      try {
        usage.addTokens(date, tokens);
      } catch (error) {
        // The CHECK constraint keeps the total within the safe integer range.
        if (error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_CHECK") {
          throw new RangeError("AI token counter overflow", { cause: error });
        }
        throw error;
      }
    },

    async getUsageStats() {
      const today = usage.get(bucket().date);
      return {
        dailyTokensUsed: today.tokens,
        dailyTokenBudget: config.aiDailyTokenBudget,
        requestsToday: today.requests,
      };
    },
  };
}
