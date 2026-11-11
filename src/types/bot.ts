/** The answers of the daily mood poll, in order. */
export const MOODS = ["umazing", "ok", "glue"] as const;
export type Mood = (typeof MOODS)[number];

export function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value);
}

/** How long the daily mood poll stays open. */
export const MOOD_POLL_HOURS = 24;
