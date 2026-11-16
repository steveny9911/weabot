/** The shared count of landmines left to step on, and who stepped on each one. */
import type { Database } from "bun:sqlite";

export function createLandmineQueries(db: Database) {
  const take = db.query<{ remaining: number }, []>(
    `UPDATE landmines SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0
     RETURNING remaining`,
  );
  const give = db.query(`UPDATE landmines SET remaining = remaining + 1 WHERE id = 1`);
  const ranked = db.query<{ userId: string; steps: number }, [number]>(
    `SELECT user_id AS userId, COUNT(*) AS steps FROM landmine_steps WHERE stepped_at >= ?
     GROUP BY user_id ORDER BY steps DESC, user_id`,
  );
  const left = db.query<{ remaining: number }, []>(`SELECT remaining FROM landmines WHERE id = 1`);
  const record = db.query(`INSERT INTO landmine_steps (user_id, stepped_at) VALUES (?, ?)`);

  return {
    /** Uses up one landmine and returns how many are left, or null when none were left. */
    claim(): number | null {
      return take.get()?.remaining ?? null;
    },
    /** Puts back a landmine that was claimed but could not be used. */
    refund(): void {
      give.run();
    },
    /** How many landmines are left to step on. */
    remaining(): number {
      return left.get()?.remaining ?? 0;
    },
    /** Everyone who stepped on a landmine at or after `since` (epoch time), most steps first. */
    stepsSince(since: number): Array<{ userId: string; steps: number }> {
      return ranked.all(since);
    },
    /** Remembers that this user stepped on a landmine just now. */
    recordStep(userId: string): void {
      record.run(userId, Date.now());
    },
  };
}
