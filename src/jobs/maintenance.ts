/** Hourly retention: old AI usage rows and expired in-memory Discord action turns. */
import type { Database } from "bun:sqlite";
import { deleteOldAiUsage } from "../db/maintenance.ts";

export function createMaintenanceJob(db: Database, turns: { sweep(): number }): () => void {
  return () => {
    const deleted = deleteOldAiUsage(db, Date.now());
    const expired = turns.sweep();
    console.log(`[MAINTENANCE] Removed ${deleted} old AI usage day(s), ${expired} expired turn(s)`);
  };
}
