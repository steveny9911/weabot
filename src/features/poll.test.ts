import { expect, test } from "bun:test";
import { buildMoodPollPayload } from "./poll.ts";
import { DEFAULT_MOOD_CONFIG } from "../types/bot.ts";

test("buildMoodPollPayload constructs correct structure", () => {
  const payload = buildMoodPollPayload("December 10, 2025", DEFAULT_MOOD_CONFIG);

  expect(payload.poll.question.text).toStrictEqual("Mood (December 10, 2025)");
  expect(payload.poll.answers.length).toStrictEqual(3);
  expect(payload.poll.answers[0].poll_media.text).toStrictEqual("umazing");
  expect(payload.poll.answers[1].poll_media.text).toStrictEqual("ok");
  expect(payload.poll.answers[2].poll_media.text).toStrictEqual("glue");
  expect(payload.poll.duration).toStrictEqual(24);
  expect(payload.poll.allow_multiselect).toStrictEqual(false);
});

test("buildMoodPollPayload respects custom duration", () => {
  const customConfig = {
    moods: ["umazing", "ok", "glue"] as const,
    durationHours: 12,
    allowMultiselect: false,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  expect(payload.poll.duration).toStrictEqual(12);
});

test("buildMoodPollPayload respects multiselect setting", () => {
  const customConfig = {
    moods: ["umazing", "ok", "glue"] as const,
    durationHours: 24,
    allowMultiselect: true,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  expect(payload.poll.allow_multiselect).toStrictEqual(true);
});

test("buildMoodPollPayload handles custom mood options", () => {
  const customConfig = {
    moods: ["umazing", "glue"] as const, // Only two moods
    durationHours: 24,
    allowMultiselect: false,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  expect(payload.poll.answers.length).toStrictEqual(2);
  expect(payload.poll.answers[0].poll_media.text).toStrictEqual("umazing");
  expect(payload.poll.answers[1].poll_media.text).toStrictEqual("glue");
});
