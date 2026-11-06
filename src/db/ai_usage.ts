/** Daily AI request and token totals (UTC days). */
import type { Database } from "bun:sqlite";

export function createAiUsageQueries(db: Database) {
  const read = db.query<{ requests: number; tokens: number }, { date: string }>(
    `SELECT requests, tokens FROM ai_daily_usage WHERE usage_date = $date`,
  );
  const addRequest = db.query(
    `INSERT INTO ai_daily_usage (usage_date, requests) VALUES ($date, 1)
     ON CONFLICT (usage_date) DO UPDATE SET requests = requests + 1`,
  );
  const addTokens = db.query(
    `INSERT INTO ai_daily_usage (usage_date, tokens) VALUES ($date, $tokens)
     ON CONFLICT (usage_date) DO UPDATE SET tokens = tokens + excluded.tokens`,
  );

  return {
    get(date: string): { requests: number; tokens: number } {
      return read.get({ date }) ?? { requests: 0, tokens: 0 };
    },
    addRequest(date: string): void {
      addRequest.run({ date });
    },
    addTokens(date: string, tokens: number): void {
      addTokens.run({ date, tokens });
    },
  };
}
