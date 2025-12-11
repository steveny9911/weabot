/**
 * Poll Payload Builder
 *
 * Contains pure functions for constructing Discord poll payloads.
 * Pure functions have no side effects and always return the same
 * output for the same input, making them easy to test.
 */

import type { CreatePollMessagePayload, PollAnswer } from "../../types/discord.ts";
import type { MoodPollConfig } from "../../types/bot.ts";

/**
 * Constructs the Discord API payload for a mood poll.
 *
 * @param dateString - The formatted date string for the poll question
 * @param config - The mood poll configuration
 * @returns A ready-to-send Discord message payload with poll
 */
export function buildMoodPollPayload(
  dateString: string,
  config: MoodPollConfig,
): CreatePollMessagePayload {
  const answers: PollAnswer[] = config.moods.map((mood) => ({
    poll_media: { text: mood },
  }));

  return {
    poll: {
      question: { text: `Mood (${dateString})` },
      answers,
      duration: config.durationHours,
      allow_multiselect: config.allowMultiselect,
    },
  };
}
