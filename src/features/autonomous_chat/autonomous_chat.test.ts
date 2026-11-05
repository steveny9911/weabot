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

Deno.test("autonomous participation shares cooldown with reactions and needs fresh humans", () => {
  const messages = [
    message("m1", "u1", 4),
    message("m2", "u2", 3),
    message("m3", "u3", 2),
    message("m4", "u4", 1),
  ];
  const previous = {
    channelId: "channel",
    latestHumanMessageId: "m4",
    latestHumanTimestampMs: NOW_MS - 60_000,
    attemptedAt: NOW_MS - 60_000,
  };
  assertEquals(
    decide(messages, { lastParticipation: previous }).reason,
    "participation cooldown active",
  );
  assertEquals(
    decide(messages, {
      lastParticipation: { ...previous, attemptedAt: NOW_MS - 40 * 60_000 },
    }).reason,
    "conversation already considered",
  );
});

Deno.test("autonomous reaction targets are fresh humans visible in context without our reaction", () => {
  const decision = decide([
    message("old", "u1", 8),
    message("m1", "u1", 4),
    message("m2", "u2", 3, "meme", { hasOwnReaction: true }),
    message("other-bot", "bot2", 2.5, "ping", { authorBot: true }),
    message("m3", "u3", 2),
    message("m4", "u4", 1),
  ], {
    maxContextMessages: 5,
    lastParticipation: {
      channelId: "channel",
      latestHumanMessageId: "old",
      latestHumanTimestampMs: NOW_MS - 8 * 60_000,
      attemptedAt: NOW_MS - 40 * 60_000,
    },
  });
  assertEquals(decision.shouldReply, true);
  assertEquals(decision.latestHumanMessage?.id, "m4");
  assertEquals(decision.reactionMessageIds, ["m1", "m3", "m4"]);
});

Deno.test("bot messages and reactions never supply required human activity", () => {
  const decision = decide([
    message("m1", "u1", 4, "meme", { hasOwnReaction: true }),
    message("m2", "haru", 3, "hi", { authorBot: true }),
    message("m3", "bot2", 2, "hi", { authorBot: true }),
    message("m4", "bot3", 1, "hi", { authorBot: true }),
  ]);
  assertEquals(decision.shouldReply, false);
  assertEquals(decision.reason, "only 1 recent human message(s)");
});

Deno.test("same-millisecond snowflakes preserve the newest human watermark and target", () => {
  const messages = [
    message("200", "u2", 1),
    message("100", "u1", 1),
  ];
  const decision = decide(messages, {
    minHumanMessages: 1,
    lastParticipation: {
      channelId: "channel",
      latestHumanMessageId: "100",
      latestHumanTimestampMs: NOW_MS - 60_000,
      attemptedAt: NOW_MS - 40 * 60_000,
    },
  });
  assertEquals(decision.shouldReply, true);
  assertEquals(decision.latestHumanMessage?.id, "200");
  assertEquals(decision.reactionMessageIds, ["200"]);
});
