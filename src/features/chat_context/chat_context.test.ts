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

Deno.test("video and other non-image attachments stay out of direct and replied-to image context", () => {
  const attachments = [
    { filename: "clip.mov", content_type: "video/quicktime" },
    { filename: "misleading.png", content_type: "video/mp4" },
    { filename: "clip.mp4" },
    { filename: "unknown.bin" },
    { filename: "diagram.svg", content_type: "image/svg+xml" },
    { filename: "scan.tiff", content_type: "image/tiff" },
    { filename: "document.pdf", content_type: "application/pdf" },
    {},
  ].map((metadata) => ({
    url: "https://cdn.example.com/clip.mov?signature=example",
    width: 640,
    height: 360,
    ...metadata,
  }));
  const mapped = oMapDiscordMessage({
    content: "What about this?",
    attachments,
    referenced_message: { content: "the clip", attachments },
  });

  assertEquals(mapped.imageUrls, []);
  assertEquals(mapped.referencedMessage?.imageUrls, []);
  assertEquals(oToAiContextMessage(mapped).repliedTo, {
    id: "",
    author: "unknown",
    content: "the clip",
    imageUrls: [],
    timestamp: null,
  });
});

Deno.test("supported images retain MIME, filename, and URL fallbacks without dimension guesses", () => {
  const mapped = oMapDiscordMessage({
    attachments: [
      { url: "https://cdn.example.com/opaque", content_type: "image/png" },
      { url: "https://cdn.example.com/photo.JPG", filename: "photo.JPG" },
      {
        url: "https://cdn.example.com/photo.webp",
        filename: "photo.webp",
        content_type: "application/octet-stream",
      },
      { proxy_url: "https://cdn.example.com/photo.jpeg?signature=example" },
      { url: "https://cdn.example.com/still.gif", content_type: "image/gif" },
      { url: "https://cdn.example.com/normalized", content_type: " IMAGE/JPEG; charset=binary " },
      { url: "not-a-url", width: 100, height: 100 },
    ],
  });

  assertEquals(mapped.imageUrls, [
    "https://cdn.example.com/opaque",
    "https://cdn.example.com/photo.JPG",
    "https://cdn.example.com/photo.webp",
    "https://cdn.example.com/photo.jpeg?signature=example",
    "https://cdn.example.com/still.gif",
    "https://cdn.example.com/normalized",
  ]);
});
