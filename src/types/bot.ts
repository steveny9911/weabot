export type Mood = "umazing" | "ok" | "glue";

export interface MoodPollConfig {
  readonly moods: readonly Mood[];
  durationHours: number;
  allowMultiselect: boolean;
}

export const DEFAULT_MOOD_CONFIG: MoodPollConfig = {
  moods: ["umazing", "ok", "glue"],
  durationHours: 24,
  allowMultiselect: false,
};
