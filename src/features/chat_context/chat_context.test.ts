import { assertEquals } from "@std/assert";
import {
  oMapDiscordMessage,
  oToAiContextMessage,
  type RecentDiscordMessage,
  selectActiveConversation,
} from "./mod.ts";

const START_MS = Date.parse("2026-08-27T12:00:00.000Z");

function message(id: string, minute: number): RecentDiscordMessage {
  return {
    id,
    authorId: `user-${id}`,
    authorName: `User ${id}`,
    authorBot: false,
    content: id,
    timestamp: new Date(START_MS + minute * 60_000).toISOString(),
    imageUrls: [],
  };
}

Deno.test("selectActiveConversation keeps a sustained conversation up to its cap", () => {
  const selected = selectActiveConversation(
    [message("m5", 5), message("m1", 1), message("m3", 3), message("m4", 4), message("m2", 2)],
    { maxMessages: 4, inactivityGapMs: 20 * 60_000 },
  );

  assertEquals(selected.map(({ id }) => id), ["m2", "m3", "m4", "m5"]);
});

Deno.test("selectActiveConversation starts over after a meaningful inactivity gap", () => {
  const selected = selectActiveConversation(
    [message("old-1", 1), message("old-2", 2), message("new-1", 30), message("new-2", 31)],
    { maxMessages: 40, inactivityGapMs: 20 * 60_000 },
  );

  assertEquals(selected.map(({ id }) => id), ["new-1", "new-2"]);
});

Deno.test("selectActiveConversation excludes messages at or before reset cutoff", () => {
  const selected = selectActiveConversation(
    [message("old", 1), message("reset", 2), message("new", 3)],
    {
      maxMessages: 40,
      inactivityGapMs: 20 * 60_000,
      resetAfterMs: START_MS + 2 * 60_000,
    },
  );

  assertEquals(selected.map(({ id }) => id), ["new"]);
});

Deno.test("Discord reply mapping carries an explicit older reference into AI context", () => {
  const mapped = oMapDiscordMessage({
    id: "reply-1",
    content: "that one",
    timestamp: "2026-08-27T12:30:00.000Z",
    author: { id: "u1", global_name: "Alice", bot: false },
    referenced_message: {
      id: "old-1",
      content: "the old topic",
      timestamp: "2026-08-27T10:00:00.000Z",
      author: { id: "u2", username: "bob" },
    },
  });

  assertEquals(oToAiContextMessage(mapped)["repliedTo"], {
    id: "old-1",
    author: "bob",
    content: "the old topic",
    imageUrls: [],
    timestamp: "2026-08-27T10:00:00.000Z",
  });
});
