import type { CreatePollMessagePayload, PollAnswer } from "../discord/types.ts";
import type { MoodPollConfig } from "../types/bot.ts";

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
