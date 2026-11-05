/** Retention deletes, run hourly by the maintenance job. */
import type { Database } from "bun:sqlite";

export const AI_USAGE_RETENTION_DAYS = 30;

/** Deletes daily AI usage older than the retention window. Returns the number of rows deleted. */
export function deleteOldAiUsage(db: Database, now: number): number {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - AI_USAGE_RETENTION_DAYS);
  return db
    .query("DELETE FROM ai_daily_usage WHERE usage_date < $cutoff")
    .run({ cutoff: cutoff.toISOString().slice(0, 10) }).changes;
}
