/** Daily AI request and token totals, by Pacific day (when provider free-tier quotas reset). */
import type { Database } from "bun:sqlite";

const pacificDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });

/** The usage day of a time, as YYYY-MM-DD. */
export function usageDate(time: number): string {
  return pacificDate.format(time);
}

export function createAiUsageQueries(db: Database) {
  const read = db.query<{ requests: number; tokens: number }, { date: string }>(
    `SELECT requests, tokens FROM ai_daily_usage WHERE usage_date = $date`,
  );
  const addRequests = db.query(
    `INSERT INTO ai_daily_usage (usage_date, requests) VALUES ($date, $requests)
     ON CONFLICT (usage_date) DO UPDATE SET requests = requests + excluded.requests`,
  );
  const addTokens = db.query(
    `INSERT INTO ai_daily_usage (usage_date, tokens) VALUES ($date, $tokens)
     ON CONFLICT (usage_date) DO UPDATE SET tokens = tokens + excluded.tokens`,
  );

  return {
    get(date: string): { requests: number; tokens: number } {
      return read.get({ date }) ?? { requests: 0, tokens: 0 };
    },
    addRequests(date: string, requests: number): void {
      addRequests.run({ date, requests });
    },
    addTokens(date: string, tokens: number): void {
      addTokens.run({ date, tokens });
    },
  };
}
