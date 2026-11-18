/** Hourly retention: old AI usage rows and expired in-memory Discord action turns. */
import type { Database } from "bun:sqlite";
import { deleteOldAiUsage } from "../db/maintenance.ts";
import { log } from "../app/log.ts";

export function createMaintenanceJob(db: Database, turns: { sweep(): number }): () => void {
  return () => {
    const deleted = deleteOldAiUsage(db, Date.now());
    const expired = turns.sweep();
    log.info("maintenance", "Removed old rows", { aiUsageDays: deleted, expiredTurns: expired });
  };
}
