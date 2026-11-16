import { expect, test } from "bun:test";
import { collectImageUrls } from "../ai/context_images.ts";
import {
  mapDiscordMessage,
  toAiContextMessage,
  type RecentDiscordMessage,
  selectActiveConversation,
} from "./chat_context.ts";

const START_MS = Date.parse("2026-08-27T12:00:00.000Z");

test("Discord mapping ignores webhook activity and preserves our reaction summary", () => {
  const mapped = mapDiscordMessage({
    id: "meme",
    content: "lol",
    timestamp: "2026-08-27T12:00:00.000Z",
    author: { id: "webhook", username: "mirror" },
    webhook_id: "webhook",
    reactions: [{ emoji: { name: "😂" }, me: true }],
  });
  expect(mapped.authorBot).toStrictEqual(true);
  expect(mapped.hasOwnReaction).toStrictEqual(true);
  expect(toAiContextMessage(mapped).hasOwnReaction).toStrictEqual(undefined);
  expect(mapDiscordMessage({ reactions: [null, { me: false }] }).hasOwnReaction).toStrictEqual(
    undefined,
  );
});

const ALT = "5 pulls since last 6★: 3★ 克洛丝 (Kroos), 6★ 能天使 (Exusiai)";
const pullImage = (description?: string) => ({
  filename: "gacha.webp",
  content_type: "image/webp",
  url: "https://cdn.example.com/gacha.webp",
  ...(description === undefined ? {} : { description }),
});

test("a bot's pull with alt text is described in the text, not sent as an image", () => {
  const mapped = mapDiscordMessage({
    id: "pull",
    author: { id: "haru", bot: true },
    content: "",
    // Padding and line breaks in the alt text are flattened.
    attachments: [pullImage(`  ${ALT.replace(": ", ":\n")} `)],
  });
  expect(mapped.imageUrls).toStrictEqual([]);
  expect(mapped.content).toStrictEqual(`[image: ${ALT}]`);
});

test("a pull's alt text follows the message's own text and keeps other images", () => {
  const mapped = mapDiscordMessage({
    author: { id: "haru", bot: true },
    content: "here",
    attachments: [
      pullImage(ALT),
      { filename: "cat.png", content_type: "image/png", url: "https://cdn.example.com/cat.png" },
    ],
  });
  expect(mapped.content).toStrictEqual(`here [image: ${ALT}]`);
  expect(mapped.imageUrls).toStrictEqual(["https://cdn.example.com/cat.png"]);
});

test("a pull with no alt text, a user's gacha.webp, and a bot's other image are still sent", () => {
  const bot = { id: "haru", bot: true };
  const url = ["https://cdn.example.com/gacha.webp"];
  expect(mapDiscordMessage({ author: bot, attachments: [pullImage()] }).imageUrls).toStrictEqual(
    url,
  );
  expect(
    mapDiscordMessage({ author: bot, attachments: [pullImage("  ")] }).imageUrls,
  ).toStrictEqual(url);
  const user = mapDiscordMessage({ author: { id: "u1" }, attachments: [pullImage(ALT)] });
  expect(user.imageUrls).toStrictEqual(url);
  expect(user.content).toStrictEqual("");
  const other = {
    filename: "art.png",
    content_type: "image/png",
    url: "https://cdn.example.com/art.png",
    description: ALT,
  };
  const art = mapDiscordMessage({ author: bot, attachments: [other] });
  expect(art.imageUrls).toStrictEqual(["https://cdn.example.com/art.png"]);
  expect(art.content).toStrictEqual("");
});

test("a replied-to pull is described by its alt text too", () => {
  const mapped = mapDiscordMessage({
    content: "what did I get?",
    author: { id: "u1" },
    referenced_message: { author: { id: "haru", bot: true }, attachments: [pullImage(ALT)] },
  });
  expect(mapped.referencedMessage?.imageUrls).toStrictEqual([]);
  expect(mapped.referencedMessage?.content).toStrictEqual(`[image: ${ALT}]`);
});

test("a message of only a pull stays in the conversation, and the pull takes no image slot", () => {
  const messages = [
    mapDiscordMessage({
      id: "1",
      timestamp: "2026-08-27T12:00:00.000Z",
      author: { id: "haru", bot: true },
      attachments: [pullImage(ALT)],
    }),
    mapDiscordMessage({
      id: "2",
      timestamp: "2026-08-27T12:01:00.000Z",
      author: { id: "u1" },
      attachments: [
        { filename: "cat.png", content_type: "image/png", url: "https://cdn.example.com/cat.png" },
      ],
    }),
  ];
  const active = selectActiveConversation(messages, {
    maxMessages: 20,
    inactivityGapMs: 3_600_000,
  });
  expect(active.map((m) => m.id)).toStrictEqual(["1", "2"]);
  expect(collectImageUrls(active.map(toAiContextMessage), 1)).toStrictEqual([
    "https://cdn.example.com/cat.png",
  ]);
});

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

test("selectActiveConversation keeps a sustained conversation up to its cap", () => {
  const selected = selectActiveConversation(
    [message("m5", 5), message("m1", 1), message("m3", 3), message("m4", 4), message("m2", 2)],
    { maxMessages: 4, inactivityGapMs: 20 * 60_000 },
  );

  expect(selected.map(({ id }) => id)).toStrictEqual(["m2", "m3", "m4", "m5"]);
});

test("selectActiveConversation starts over after a meaningful inactivity gap", () => {
  const selected = selectActiveConversation(
    [message("old-1", 1), message("old-2", 2), message("new-1", 30), message("new-2", 31)],
    { maxMessages: 40, inactivityGapMs: 20 * 60_000 },
  );

  expect(selected.map(({ id }) => id)).toStrictEqual(["new-1", "new-2"]);
});

test("selectActiveConversation excludes messages at or before reset cutoff", () => {
  const selected = selectActiveConversation(
    [message("old", 1), message("reset", 2), message("new", 3)],
    {
      maxMessages: 40,
      inactivityGapMs: 20 * 60_000,
      resetAfterMs: START_MS + 2 * 60_000,
    },
  );

  expect(selected.map(({ id }) => id)).toStrictEqual(["new"]);
});

test("Discord reply mapping carries an explicit older reference into AI context", () => {
  const mapped = mapDiscordMessage({
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

  expect(toAiContextMessage(mapped)["repliedTo"]).toStrictEqual({
    id: "old-1",
    author: "bob",
    content: "the old topic",
    imageUrls: [],
    timestamp: "2026-08-27T10:00:00.000Z",
  });
});

test("video and other non-image attachments stay out of direct and replied-to image context", () => {
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
  const mapped = mapDiscordMessage({
    content: "What about this?",
    attachments,
    referenced_message: { content: "the clip", attachments },
  });

  expect(mapped.imageUrls).toStrictEqual([]);
  expect(mapped.referencedMessage?.imageUrls).toStrictEqual([]);
  expect(toAiContextMessage(mapped).repliedTo).toStrictEqual({
    id: "",
    author: "unknown",
    content: "the clip",
    imageUrls: [],
    timestamp: null,
  });
});

test("supported images retain MIME, filename, and URL fallbacks without dimension guesses", () => {
  const mapped = mapDiscordMessage({
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

  expect(mapped.imageUrls).toStrictEqual([
    "https://cdn.example.com/opaque",
    "https://cdn.example.com/photo.JPG",
    "https://cdn.example.com/photo.webp",
    "https://cdn.example.com/photo.jpeg?signature=example",
    "https://cdn.example.com/still.gif",
    "https://cdn.example.com/normalized",
  ]);
});
