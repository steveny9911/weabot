/**
 * Persistent AI usage counters and atomic request admission.
 *
 * The daily budget is a soft threshold on reported usage: admitted requests may
 * finish above it. It is not a reservation or a strict cap on in-flight tokens.
 */

import type { AppConfig } from "../config.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export type RequestAdmission =
  & RateLimitResult
  & (
    | { allowed: true }
    | { allowed: false; reason: "user_limit" | "daily_budget" }
  );

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

const MINUTE_TTL_MS = 2 * 60_000;
const DAILY_TTL_MS = 48 * 60 * 60_000;
const MAX_COMMIT_ATTEMPTS = 100;

/** Bounded jittered backoff avoids spinning or silently losing a failed update. */
async function retryConflict(attempt: number): Promise<void> {
  if (attempt >= MAX_COMMIT_ATTEMPTS) {
    throw new Error("AI usage transaction failed after repeated conflicts");
  }
  await new Promise((resolve) =>
    setTimeout(resolve, 1 + Math.random() * Math.min(32, 2 ** Math.min(attempt, 5)))
  );
}

/** Numeric CAS updates preserve pre-existing KV values and expiration periods. */
export function createRateLimitService(
  kv: Deno.Kv,
  config: AppConfig,
  now: () => number = Date.now,
): RateLimitService {
  function bucket(time = now()) {
    const iso = new Date(time).toISOString();
    return {
      minute: iso.slice(0, 16),
      date: iso.slice(0, 10),
      resetInMs: 60_000 - (time % 60_000),
    };
  }

  async function countRequest(
    userId: string,
    enforceBudget: boolean,
    enforceUserLimit: boolean,
  ): Promise<RequestAdmission> {
    for (let attempt = 1;; attempt++) {
      const current = bucket();
      const userKey = ["ai_usage", "user", userId, current.minute];
      const requestsKey = ["ai_usage", "daily_requests", current.date];
      const tokensKey = ["ai_usage", "daily_tokens", current.date];
      const [user, requests, tokens] = await kv.getMany<[number, number, number]>([
        userKey,
        requestsKey,
        tokensKey,
      ]);
      // An asynchronous read or conflict retry must not admit into an old minute.
      const latest = bucket();
      if (latest.minute !== current.minute) {
        await retryConflict(attempt);
        continue;
      }
      const count = user.value ?? 0;
      const result = {
        remaining: Math.max(0, config.aiRateLimitPerUser - count),
        resetInMs: latest.resetInMs,
      };
      if (enforceUserLimit && count >= config.aiRateLimitPerUser) {
        return { ...result, allowed: false, reason: "user_limit" };
      }
      if (enforceBudget && (tokens.value ?? 0) >= config.aiDailyTokenBudget) {
        return { ...result, allowed: false, reason: "daily_budget" };
      }
      const transaction = kv.atomic().check(user, requests)
        .set(userKey, count + 1, { expireIn: MINUTE_TTL_MS })
        .set(requestsKey, (requests.value ?? 0) + 1, { expireIn: DAILY_TTL_MS });
      // If completed usage changed during admission, retry the budget check.
      if (enforceBudget) transaction.check(tokens);
      if ((await transaction.commit()).ok) {
        return { ...result, allowed: true, remaining: Math.max(0, result.remaining - 1) };
      }
      await retryConflict(attempt);
    }
  }

  return {
    admitRequest(userId, options) {
      return countRequest(userId, true, options?.enforceUserLimit ?? true);
    },

    async checkUserRateLimit(userId) {
      const current = bucket();
      const entry = await kv.get<number>(["ai_usage", "user", userId, current.minute]);
      const count = entry.value ?? 0;
      return {
        allowed: count < config.aiRateLimitPerUser,
        remaining: Math.max(0, config.aiRateLimitPerUser - count),
        resetInMs: current.resetInMs,
      };
    },

    async recordUserRequest(userId) {
      await countRequest(userId, false, false);
    },

    async checkDailyBudget() {
      const entry = await kv.get<number>(["ai_usage", "daily_tokens", bucket().date]);
      const used = entry.value ?? 0;
      return {
        allowed: used < config.aiDailyTokenBudget,
        tokensRemaining: Math.max(0, config.aiDailyTokenBudget - used),
      };
    },

    async recordTokenUsage(tokens) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new RangeError("Reported token usage must be a non-negative safe integer");
      }
      // Pin the recording day before retries; one update cannot cross buckets.
      const key = ["ai_usage", "daily_tokens", bucket().date];
      for (let attempt = 1;; attempt++) {
        const entry = await kv.get<number>(key);
        const total = (entry.value ?? 0) + tokens;
        if (!Number.isSafeInteger(total)) throw new RangeError("AI token counter overflow");
        const result = await kv.atomic().check(entry)
          .set(key, total, { expireIn: DAILY_TTL_MS }).commit();
        if (result.ok) return;
        await retryConflict(attempt);
      }
    },

    async getUsageStats() {
      const date = bucket().date;
      const [tokens, requests] = await kv.getMany<[number, number]>([
        ["ai_usage", "daily_tokens", date],
        ["ai_usage", "daily_requests", date],
      ]);
      return {
        dailyTokensUsed: tokens.value ?? 0,
        dailyTokenBudget: config.aiDailyTokenBudget,
        requestsToday: requests.value ?? 0,
      };
    },
  };
}
