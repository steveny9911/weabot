import type { CreatePollMessagePayload } from "../discord/types.ts";
import { MOOD_POLL_HOURS, MOODS } from "../types/bot.ts";

/** The daily mood poll: one answer per mood, open for `MOOD_POLL_HOURS`. */
export function buildMoodPollPayload(dateString: string): CreatePollMessagePayload {
  return {
    poll: {
      question: { text: `Mood (${dateString})` },
      answers: MOODS.map((mood) => ({ poll_media: { text: mood } })),
      duration: MOOD_POLL_HOURS,
      allow_multiselect: false,
    },
  };
}
