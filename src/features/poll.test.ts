import { expect, test } from "bun:test";
import { buildMoodPollPayload } from "./poll.ts";

test("buildMoodPollPayload asks for one mood for a day", () => {
  expect(buildMoodPollPayload("December 10, 2025")).toStrictEqual({
    poll: {
      question: { text: "Mood (December 10, 2025)" },
      answers: [
        { poll_media: { text: "umazing" } },
        { poll_media: { text: "ok" } },
        { poll_media: { text: "glue" } },
      ],
      duration: 24,
      allow_multiselect: false,
    },
  });
});
