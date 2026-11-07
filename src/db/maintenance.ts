/** Retention deletes, run hourly by the maintenance job. */
import type { Database } from "bun:sqlite";
import { usageDate } from "./ai_usage.ts";

export const AI_USAGE_RETENTION_DAYS = 30;

/** Deletes daily AI usage older than the retention window. Returns the number of rows deleted. */
export function deleteOldAiUsage(db: Database, now: number): number {
  const cutoff = usageDate(now - AI_USAGE_RETENTION_DAYS * 86_400_000);
  return db.query("DELETE FROM ai_daily_usage WHERE usage_date < $cutoff").run({ cutoff }).changes;
}
