import { type Database, SQLiteError } from "bun:sqlite";
import type { AppConfig } from "../config.ts";
import { createAiUsageQueries, usageDate } from "../db/ai_usage.ts";

export type RequestAdmission = { remaining: number; resetInMs: number } & (
  { allowed: true } | { allowed: false; reason: "user_limit" | "daily_budget" }
);

export interface UsageStats {
  dailyTokensUsed: number;
  dailyTokenBudget: number;
  requestsToday: number;
}

export interface RateLimitService {
  /**
   * Atomically checks the limits and counts one model call. `requestPercent` is the share of
   * AI_DAILY_REQUEST_QUOTA this caller may use; it defaults to AI_DAILY_REQUEST_PERCENT.
   */
  admitRequest(
    userId: string,
    options?: { enforceUserLimit?: boolean; requestPercent?: number },
  ): Promise<RequestAdmission>;
  /** Records model calls beyond the one counted at admission, e.g. tool-loop steps. */
  recordModelCalls(calls: number | undefined): Promise<void>;
  /** Records reported tokens in the current usage day. */
  recordTokenUsage(tokens: number): Promise<void>;
  getUsageStats(): Promise<UsageStats>;
}

/**
 * Per-user counts live in memory for the current UTC minute; daily totals are in SQLite. The daily
 * token budget and request quota are soft thresholds: requests already admitted may finish above.
 */
export function createRateLimitService(
  db: Database,
  config: AppConfig,
  now: () => number = Date.now,
): RateLimitService {
  const usage = createAiUsageQueries(db);
  const minuteCounts = new Map<string, { minute: string; count: number }>();
  let prunedMinute = "";

  function bucket(time = now()) {
    return {
      minute: new Date(time).toISOString().slice(0, 16),
      date: usageDate(time),
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

  // The minute count is updated only after the commit, so a failed write consumes no allowance.
  const admitTransaction = db.transaction(
    (
      userId: string,
      enforceUserLimit: boolean,
      requestPercent: number,
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
      const today = usage.get(current.date);
      const quota = config.aiDailyRequestQuota;
      if (
        today.tokens >= config.aiDailyTokenBudget ||
        (quota !== undefined && today.requests >= Math.floor((quota * requestPercent) / 100))
      ) {
        return refused("daily_budget");
      }
      usage.addRequests(current.date, 1);
      return {
        admission: { ...result, allowed: true, remaining: Math.max(0, result.remaining - 1) },
        minute: current.minute,
        count: count + 1,
      };
    },
  );

  return {
    async admitRequest(userId, options) {
      const { admission, minute, count } = admitTransaction.immediate(
        userId,
        options?.enforceUserLimit ?? true,
        options?.requestPercent ?? config.aiDailyRequestPercent,
      );
      if (admission.allowed) minuteCounts.set(userId, { minute, count });
      return admission;
    },

    async recordModelCalls(calls = 1) {
      if (calls > 1) usage.addRequests(bucket().date, calls - 1);
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
