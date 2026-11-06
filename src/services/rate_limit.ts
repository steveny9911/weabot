import { type Database, SQLiteError } from "bun:sqlite";
import type { AppConfig } from "../config.ts";
import { createAiUsageQueries } from "../db/ai_usage.ts";

export type RequestAdmission = { remaining: number; resetInMs: number } & (
  { allowed: true } | { allowed: false; reason: "user_limit" | "daily_budget" }
);

export interface UsageStats {
  dailyTokensUsed: number;
  dailyTokenBudget: number;
  requestsToday: number;
}

export interface RateLimitService {
  /** Atomically checks the limits and counts one accepted request. */
  admitRequest(userId: string, options?: { enforceUserLimit?: boolean }): Promise<RequestAdmission>;
  /** Records reported tokens in the current UTC day. */
  recordTokenUsage(tokens: number): Promise<void>;
  getUsageStats(): Promise<UsageStats>;
}

/**
 * Per-user counts live in memory for the current UTC minute; daily totals are in SQLite. The daily
 * budget is a soft threshold: requests already admitted may finish above it.
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

  // The minute count is updated only after the commit, so a failed write consumes no allowance.
  const admitTransaction = db.transaction(
    (
      userId: string,
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
      if (usage.get(current.date).tokens >= config.aiDailyTokenBudget) {
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

  return {
    async admitRequest(userId, options) {
      const { admission, minute, count } = admitTransaction.immediate(
        userId,
        options?.enforceUserLimit ?? true,
      );
      if (admission.allowed) minuteCounts.set(userId, { minute, count });
      return admission;
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
