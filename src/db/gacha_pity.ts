/** Each user's gacha pity: pulls in a row without a 6-star. */
import type { Database } from "bun:sqlite";

export interface GachaPityQueries {
  /** The user's pity, or null if they have never pulled. */
  get(userId: string): number | null;
  /** Remembers the user's pity (0 to 98) after a pull. */
  save(userId: string, pity: number, now?: number): void;
}

export function createGachaPityQueries(db: Database): GachaPityQueries {
  const read = db.query<{ pity: number }, [string]>(
    "SELECT pity FROM gacha_pity WHERE user_id = ?",
  );
  const write = db.query(
    `INSERT INTO gacha_pity (user_id, pity, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET pity = excluded.pity, updated_at = excluded.updated_at`,
  );

  return {
    get: (userId) => read.get(userId)?.pity ?? null,
    save: (userId, pity, now = Date.now()) => void write.run(userId, pity, now),
  };
}
