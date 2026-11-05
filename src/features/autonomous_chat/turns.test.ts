import { expect, test } from "bun:test";
import { conversationTurns } from "./turns.ts";
import { decideAutonomousChatReply } from "./mod.ts";
import type { RecentDiscordMessage } from "../chat_context/mod.ts";
const now = Date.parse("2026-10-13T22:06:00Z");
function message(
  id: string,
  content: string,
  offset = 0,
  authorId = "human",
): RecentDiscordMessage {
  return {
    id,
    content,
    authorId,
    authorName: authorId,
    authorBot: false,
    imageUrls: [],
    timestamp: new Date(now - 40000 + offset).toISOString(),
  };
}
const options = {
  botUserId: "bot",
  nowMs: now,
  minHumanMessages: 1,
  activityWindowMs: 1200000,
  inactivityGapMs: 1200000,
  cooldownMs: 60000,
  maxContextMessages: 40,
  replyChance: 1,
  random: () => 0,
  settleMs: 8000,
};
test("incident split joke allows the punchline, not connective/setup/trailing laughter", () => {
  const messages = [
    message("1", "Starbucks?"),
    message("2", "More like", 1733),
    message("3", "starfucks", 3252),
    message("4", "xdd", 11585),
  ];
  const decision = decideAutonomousChatReply([...messages].reverse(), options);
  expect(decision.reactionMessageIds).toStrictEqual(["3"]);
  expect(decision.latestHumanMessage?.id).toStrictEqual("4");
  expect(decision.contextMessages.map((m) => m.turnId)).toStrictEqual(["1", "1", "1", "1"]);
});
test("ongoing bursts and incomplete turns do not consume the participation watermark", () => {
  expect(decideAutonomousChatReply([message("1", "More like")], options).shouldReply).toStrictEqual(
    false,
  );
  expect(
    decideAutonomousChatReply([message("1", "A good joke", 39000)], options).reason,
  ).toStrictEqual("human message burst still settling");
});
test("short complete utterances and image memes remain anchors", () => {
  const image = { ...message("1", ""), imageUrls: ["https://example.com/meme.png"] };
  expect(
    conversationTurns([image, message("2", "gg", 1000), message("3", "nice", 2000)])[0].anchorIds,
  ).toStrictEqual(["1", "2", "3"]);
});
test("interleaved authors and changed reply references retain distinct turns", () => {
  const base = message("old", "Old context");
  const a = { ...message("1", "Joke?"), referencedMessage: base };
  const b = message("2", "Another topic", 1000, "other");
  const c = message("3", "More like", 2000);
  const d = message("4", "The punchline", 3000);
  const e = {
    ...message("5", "Unrelated reply", 4000),
    referencedMessage: message("different", "Different topic"),
  };
  expect(conversationTurns([a, b, c, d, e]).map((t) => t.messages.map((m) => m.id))).toStrictEqual([
    ["1"],
    ["2"],
    ["3", "4"],
    ["5"],
  ]);
});
test("old reply references provide context without becoming reaction targets", () => {
  const current = {
    ...message("1", "That is funny"),
    referencedMessage: message("old", "Old joke", -3600000),
  };
  const d = decideAutonomousChatReply([current], options);
  expect(d.reactionMessageIds).toStrictEqual(["1"]);
  expect(d.contextMessages[0].turnMessageIds).toStrictEqual(["1"]);
});
