/**
 * Weabot Domain Types
 *
 * Internal types specific to Weabot's functionality.
 * These are our "application layer" data structures.
 */

/** The three mood states in Weabot (Umamusume-themed) */
export type Mood = "umazing" | "ok" | "glue";

/** Configuration for a daily mood poll */
export interface MoodPollConfig {
  readonly moods: readonly Mood[];
  durationHours: number;
  allowMultiselect: boolean;
}

/** Default configuration for the daily mood poll */
export const DEFAULT_MOOD_CONFIG: MoodPollConfig = {
  moods: ["umazing", "ok", "glue"],
  durationHours: 24,
  allowMultiselect: false,
};
