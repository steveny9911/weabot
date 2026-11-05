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
  // Counts for the current UTC minute only. Entries from earlier minutes are dropped when the
  // minute changes, so the map holds at most the users seen in one minute.
  const minuteCounts = new Map<string, { minute: string; count: number }>();
  let prunedMinute = "";

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

  function prune(minute: string): void {
    if (minute === prunedMinute) return;
    for (const [id, entry] of minuteCounts) if (entry.minute !== minute) minuteCounts.delete(id);
    prunedMinute = minute;
  }

  // The daily count is written in the transaction; the minute count is updated only after the
  // transaction commits, so a failed commit cannot leave memory ahead of the database.
  const admitTransaction = db.transaction(
    (
      userId: string,
      enforceBudget: boolean,
      enforceUserLimit: boolean,
    ): { admission: RequestAdmission; minute: string; count: number } => {
      const current = bucket();
      prune(current.minute);
      const count = userCount(userId, current.minute);
      const result = {
        remaining: Math.max(0, config.aiRateLimitPerUser - count),
        resetInMs: current.resetInMs,
      };
      const refused = (reason: "user_limit" | "daily_budget") => ({
        admission: { ...result, allowed: false as const, reason },
        minute: current.minute,
        count,
      });
      if (enforceUserLimit && count >= config.aiRateLimitPerUser) return refused("user_limit");
      if (enforceBudget && usage.get(current.date).tokens >= config.aiDailyTokenBudget) {
        return refused("daily_budget");
      }
      usage.addRequest(current.date);
      return {
        admission: { ...result, allowed: true, remaining: Math.max(0, result.remaining - 1) },
        minute: current.minute,
        count: count + 1,
      };
    },
  );

  function admit(
    userId: string,
    enforceBudget: boolean,
    enforceUserLimit: boolean,
  ): RequestAdmission {
    const { admission, minute, count } = admitTransaction.immediate(
      userId,
      enforceBudget,
      enforceUserLimit,
    );
    if (admission.allowed) minuteCounts.set(userId, { minute, count });
    return admission;
  }

  return {
    async admitRequest(userId, options) {
      return admit(userId, true, options?.enforceUserLimit ?? true);
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
      admit(userId, false, false);
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
