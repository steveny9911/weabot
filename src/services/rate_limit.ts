/**
 * Rate Limit Service
 *
 * Handles rate limiting for AI requests to prevent API cost overruns.
 * Uses Deno KV for persistent storage of usage data.
 */

import type { AppConfig } from "../config.ts";

/** Result of a rate limit check */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

/** Result of a budget check */
export interface BudgetResult {
  allowed: boolean;
  tokensRemaining: number;
}

/** Usage statistics for monitoring */
export interface UsageStats {
  dailyTokensUsed: number;
  dailyTokenBudget: number;
  requestsToday: number;
}

/** Rate limit service interface for dependency injection */
export interface RateLimitService {
  /** Check if a user is within their rate limit */
  checkUserRateLimit(userId: string): Promise<RateLimitResult>;

  /** Record that a user made an AI request */
  recordUserRequest(userId: string): Promise<void>;

  /** Check if we're within the daily token budget */
  checkDailyBudget(): Promise<BudgetResult>;

  /** Record token usage from an AI response */
  recordTokenUsage(tokens: number): Promise<void>;

  /** Get current usage stats for monitoring */
  getUsageStats(): Promise<UsageStats>;
}

/**
 * Creates a rate limit service backed by Deno KV.
 */
export function createRateLimitService(
  kv: Deno.Kv,
  config: AppConfig,
): RateLimitService {
  /**
   * Get the current minute key for rate limiting.
   * Format: "YYYY-MM-DDTHH:MM" (e.g., "2026-01-18T14:30")
   */
  function getCurrentMinuteKey(): string {
    const now = new Date();
    return now.toISOString().slice(0, 16); // "2026-01-18T14:30"
  }

  /**
   * Get the current date key for daily budgets.
   * Format: "YYYY-MM-DD" (e.g., "2026-01-18")
   */
  function getCurrentDateKey(): string {
    const now = new Date();
    return now.toISOString().slice(0, 10); // "2026-01-18"
  }

  /**
   * Calculate milliseconds until the next minute.
   */
  function msUntilNextMinute(): number {
    const now = new Date();
    const next_minute = new Date(now);
    next_minute.setMinutes(next_minute.getMinutes() + 1, 0, 0);
    return next_minute.getTime() - now.getTime();
  }

  return {
    async checkUserRateLimit(userId: string): Promise<RateLimitResult> {
      const minute_key = getCurrentMinuteKey();
      const kv_key = ["ai_usage", "user", userId, minute_key];

      const entry = await kv.get<number>(kv_key);
      const current_count = entry.value ?? 0;

      const allowed = current_count < config.aiRateLimitPerUser;
      const remaining = Math.max(0, config.aiRateLimitPerUser - current_count);
      const reset_in_ms = msUntilNextMinute();

      return {
        allowed,
        remaining,
        resetInMs: reset_in_ms,
      };
    },

    async recordUserRequest(userId: string): Promise<void> {
      const minute_key = getCurrentMinuteKey();
      const kv_key = ["ai_usage", "user", userId, minute_key];

      // Get current count and increment
      const entry = await kv.get<number>(kv_key);
      const current_count = entry.value ?? 0;

      // Set with expiration (2 minutes to be safe, since we key by minute)
      await kv.set(kv_key, current_count + 1, {
        expireIn: 2 * 60 * 1000, // 2 minutes in ms
      });

      // Also increment daily request counter
      const date_key = getCurrentDateKey();
      const daily_requests_key = ["ai_usage", "daily_requests", date_key];
      const daily_entry = await kv.get<number>(daily_requests_key);
      const daily_count = daily_entry.value ?? 0;

      await kv.set(daily_requests_key, daily_count + 1, {
        expireIn: 48 * 60 * 60 * 1000, // 48 hours in ms
      });
    },

    async checkDailyBudget(): Promise<BudgetResult> {
      const date_key = getCurrentDateKey();
      const kv_key = ["ai_usage", "daily_tokens", date_key];

      const entry = await kv.get<number>(kv_key);
      const tokens_used = entry.value ?? 0;

      const allowed = tokens_used < config.aiDailyTokenBudget;
      const tokens_remaining = Math.max(0, config.aiDailyTokenBudget - tokens_used);

      return {
        allowed,
        tokensRemaining: tokens_remaining,
      };
    },

    async recordTokenUsage(tokens: number): Promise<void> {
      const date_key = getCurrentDateKey();
      const kv_key = ["ai_usage", "daily_tokens", date_key];

      const entry = await kv.get<number>(kv_key);
      const current_total = entry.value ?? 0;

      await kv.set(kv_key, current_total + tokens, {
        expireIn: 48 * 60 * 60 * 1000, // 48 hours in ms
      });
    },

    async getUsageStats(): Promise<UsageStats> {
      const date_key = getCurrentDateKey();

      // Get daily tokens used
      const tokens_entry = await kv.get<number>(["ai_usage", "daily_tokens", date_key]);
      const daily_tokens_used = tokens_entry.value ?? 0;

      // Get daily request count
      const requests_entry = await kv.get<number>(["ai_usage", "daily_requests", date_key]);
      const requests_today = requests_entry.value ?? 0;

      return {
        dailyTokensUsed: daily_tokens_used,
        dailyTokenBudget: config.aiDailyTokenBudget,
        requestsToday: requests_today,
      };
    },
  };
}
