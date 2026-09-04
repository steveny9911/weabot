import { assertEquals } from "@std/assert";
import { decideAutonomousChatReply, type RecentDiscordMessage } from "./mod.ts";

const NOW_MS = Date.parse("2026-06-11T20:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

function message(
  id: string,
  authorId: string,
  minutesAgo: number,
  content = "hello",
  overrides: Partial<RecentDiscordMessage> = {},
): RecentDiscordMessage {
  return {
    id,
    authorId,
    authorName: `user-${authorId}`,
    authorBot: false,
    content,
    timestamp: isoMinutesAgo(minutesAgo),
    imageUrls: [],
    ...overrides,
  };
}

function decide(
  messages: RecentDiscordMessage[],
  overrides: Partial<Parameters<typeof decideAutonomousChatReply>[1]> = {},
) {
  return decideAutonomousChatReply(messages, {
    botUserId: "haru",
    nowMs: NOW_MS,
    minHumanMessages: 4,
    activityWindowMs: 20 * 60_000,
    inactivityGapMs: 20 * 60_000,
    cooldownMs: 30 * 60_000,
    maxContextMessages: 40,
    replyChance: 1,
    random: () => 0,
    ...overrides,
  });
}

Deno.test("decideAutonomousChatReply skips when there is not enough recent human activity", () => {
  const decision = decide([
    message("m1", "u1", 4),
    message("m2", "u2", 3),
    message("m3", "u3", 2),
  ]);

  assertEquals(decision.shouldReply, false);
  assertEquals(decision.reason, "only 3 recent human message(s)");
});

Deno.test("decideAutonomousChatReply skips while Haru cooldown is active", () => {
  const decision = decide([
    message("m1", "u1", 10),
    message("m2", "u2", 9),
    message("m3", "haru", 8, "same", { authorBot: true }),
    message("m4", "u3", 7),
    message("m5", "u4", 6),
    message("m6", "u5", 5),
    message("m7", "u6", 4),
  ]);

  assertEquals(decision.shouldReply, false);
  assertEquals(decision.reason, "cooldown active");
});

Deno.test("decideAutonomousChatReply skips when nobody spoke after Haru", () => {
  const decision = decide(
    [
      message("m1", "u1", 55),
      message("m2", "u2", 54),
      message("m3", "u3", 53),
      message("m4", "u4", 52),
      message("m5", "haru", 50, "bye", { authorBot: true }),
    ],
    { activityWindowMs: 120 * 60_000 },
  );

  assertEquals(decision.shouldReply, false);
  assertEquals(decision.reason, "no human message after Haru");
});

Deno.test("decideAutonomousChatReply skips when the random gate misses", () => {
  const decision = decide(
    [
      message("m1", "u1", 4),
      message("m2", "u2", 3),
      message("m3", "u3", 2),
      message("m4", "u4", 1),
    ],
    { replyChance: 0.25, random: () => 0.9 },
  );

  assertEquals(decision.shouldReply, false);
  assertEquals(decision.reason, "random gate skipped");
});

Deno.test("decideAutonomousChatReply returns capped oldest-to-newest context when eligible", () => {
  const decision = decide(
    [
      message("m1", "u1", 5, "one"),
      message("m2", "u2", 4, "two"),
      message("m3", "u3", 3, "three"),
      message("m4", "u4", 2, "four"),
      message("m5", "u5", 1, "five"),
    ],
    { maxContextMessages: 3 },
  );

  assertEquals(decision.shouldReply, true);
  assertEquals(decision.reason, "active conversation eligible");
  assertEquals(decision.contextMessages.map((context) => context.id), ["m3", "m4", "m5"]);
});

Deno.test("decideAutonomousChatReply excludes messages before an inactivity gap", () => {
  const decision = decide([
    message("stale-1", "u1", 45, "old topic"),
    message("m1", "u1", 8, "one"),
    message("m2", "u2", 6, "two"),
    message("m3", "u3", 4, "three"),
    message("m4", "u4", 2, "four"),
  ]);

  assertEquals(decision.shouldReply, true);
  assertEquals(decision.contextMessages.map((context) => context.id), ["m1", "m2", "m3", "m4"]);
});

Deno.test("decideAutonomousChatReply honors a persisted context reset", () => {
  const decision = decide(
    [
      message("old-1", "u1", 8, "old topic"),
      message("old-2", "u2", 7, "still old"),
      message("m1", "u1", 4, "one"),
      message("m2", "u2", 3, "two"),
      message("m3", "u3", 2, "three"),
      message("m4", "u4", 1, "four"),
    ],
    { resetAfterMs: NOW_MS - 5 * 60_000 },
  );

  assertEquals(decision.shouldReply, true);
  assertEquals(decision.contextMessages.map((context) => context.id), ["m1", "m2", "m3", "m4"]);
});
