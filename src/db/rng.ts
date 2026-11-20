/** Each user's \rng number for one day. */
import type { Database } from "bun:sqlite";

export interface RngQueries {
  /** The user's latest number and the day it was drawn, or null if they never drew. */
  get(userId: string): { date: string; number: string } | null;
  /** Remembers the number the user drew on `date`, replacing an earlier day's. */
  save(userId: string, date: string, number: string): void;
}

export function createRngQueries(db: Database): RngQueries {
  const read = db.query<{ date: string; number: string }, [string]>(
    "SELECT rng_date AS date, number FROM rng_daily WHERE user_id = ?",
  );
  const write = db.query(
    `INSERT INTO rng_daily (user_id, rng_date, number) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET rng_date = excluded.rng_date, number = excluded.number`,
  );

  return {
    get: (userId) => read.get(userId),
    save: (userId, date, number) => void write.run(userId, date, number),
  };
}
