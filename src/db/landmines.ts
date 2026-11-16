/** The shared count of landmines left to step on, and who stepped on each one. */
import type { Database } from "bun:sqlite";

export function createLandmineQueries(db: Database) {
  const take = db.query<{ remaining: number }, []>(
    `UPDATE landmines SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0
     RETURNING remaining`,
  );
  const give = db.query(`UPDATE landmines SET remaining = remaining + 1 WHERE id = 1`);
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
    /** Remembers that this user stepped on a landmine just now. */
    recordStep(userId: string): void {
      record.run(userId, Date.now());
    },
  };
}
