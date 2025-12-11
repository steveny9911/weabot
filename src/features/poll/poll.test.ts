/**
 * Poll Feature Unit Tests
 *
 * Tests the pure payload builder function.
 * Since it's a pure function, we don't need any mocks -
 * just call it with inputs and verify the outputs.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { buildMoodPollPayload } from "./payload.ts";
import { DEFAULT_MOOD_CONFIG } from "../../types/bot.ts";

Deno.test("buildMoodPollPayload constructs correct structure", () => {
  const payload = buildMoodPollPayload("December 10, 2025", DEFAULT_MOOD_CONFIG);

  assertEquals(payload.poll.question.text, "Mood (December 10, 2025)");
  assertEquals(payload.poll.answers.length, 3);
  assertEquals(payload.poll.answers[0].poll_media.text, "umazing");
  assertEquals(payload.poll.answers[1].poll_media.text, "ok");
  assertEquals(payload.poll.answers[2].poll_media.text, "glue");
  assertEquals(payload.poll.duration, 24);
  assertEquals(payload.poll.allow_multiselect, false);
});

Deno.test("buildMoodPollPayload respects custom duration", () => {
  const customConfig = {
    moods: ["umazing", "ok", "glue"] as const,
    durationHours: 12,
    allowMultiselect: false,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  assertEquals(payload.poll.duration, 12);
});

Deno.test("buildMoodPollPayload respects multiselect setting", () => {
  const customConfig = {
    moods: ["umazing", "ok", "glue"] as const,
    durationHours: 24,
    allowMultiselect: true,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  assertEquals(payload.poll.allow_multiselect, true);
});

Deno.test("buildMoodPollPayload handles custom mood options", () => {
  const customConfig = {
    moods: ["umazing", "glue"] as const, // Only two moods
    durationHours: 24,
    allowMultiselect: false,
  };

  const payload = buildMoodPollPayload("Test Date", customConfig);

  assertEquals(payload.poll.answers.length, 2);
  assertEquals(payload.poll.answers[0].poll_media.text, "umazing");
  assertEquals(payload.poll.answers[1].poll_media.text, "glue");
});
