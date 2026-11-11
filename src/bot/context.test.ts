import { expect, test } from "bun:test";
import { testConfig } from "../../tests/support/config.ts";
import { fakeDiscord } from "../../tests/support/discord.ts";
import { loadContext } from "./context.ts";

test("loadContext stores image attachment URLs in context", async () => {
  const channelId = "channel-images-1";
  const config = testConfig({ aiContextMaxMessages: 5 });
  const trigger = {
    id: "m-trigger",
    content: "trigger",
    author: { id: "u-trigger", username: "alice" },
    timestamp: "2026-03-01T00:00:01.000Z",
  };
  const ctx = await loadContext(
    fakeDiscord({
      recent: [
        {
          id: "m1",
          content: "here is an image",
          author: { id: "u1", username: "alice" },
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
              content_type: "image/png",
              filename: "cat.png",
            },
            {
              url: "https://cdn.discordapp.com/attachments/1/2/readme.txt",
              content_type: "text/plain",
              filename: "readme.txt",
            },
          ],
          timestamp: "2026-03-01T00:00:00.000Z",
        },
      ],
    }),
    config,
    channelId,
    trigger,
  );

  expect(ctx.length).toStrictEqual(2);
  expect(ctx[0]["imageUrls"]).toStrictEqual(["https://cdn.discordapp.com/attachments/1/2/cat.png"]);
});

test("loadContext handles trigger inclusion, proxy_url image extraction, and trimming", async () => {
  const channelId = "channel-savecontext-trim";
  const config = testConfig({ aiContextMaxMessages: 2 });
  const trigger = {
    id: "m2",
    content: "trigger replacement",
    author: { id: "u2", username: "bob" },
    channel_id: channelId,
    timestamp: "2026-03-01T12:00:03.000Z",
  };
  const ctx = await loadContext(
    fakeDiscord({
      recent: [
        {
          id: "m3",
          content: "newest",
          author: { id: "u3" },
          attachments: [
            null,
            {
              content_type: "image/png",
              filename: "missing-url.png",
            },
            {
              url: "not-a-url",
              content_type: "image/png",
            },
            {
              proxy_url: "https://media.discordapp.net/attachments/1/2/proxy.webp",
              width: 100,
              height: 100,
            },
            {
              url: "ftp://bad.example/file.png",
              content_type: "image/png",
            },
          ],
          timestamp: "2026-03-01T12:00:02.000Z",
        },
        {
          id: "m2",
          content: "middle",
          author: { id: "u2", username: "bob" },
          timestamp: "2026-03-01T12:00:01.000Z",
        },
        {
          id: "m1",
          content: "oldest",
          author: { id: "u1", username: "alice" },
          timestamp: "2026-03-01T12:00:00.000Z",
        },
      ],
    }),
    config,
    channelId,
    trigger,
  );
  expect(ctx.length).toStrictEqual(2);
  expect(ctx[0]["id"]).toStrictEqual("m3");
  expect(ctx[1]["id"]).toStrictEqual("m2");
  expect(ctx[0]["author"]).toStrictEqual("u3");
  expect(ctx[0]["imageUrls"]).toStrictEqual([
    "https://media.discordapp.net/attachments/1/2/proxy.webp",
  ]);
  expect(ctx[0]["timestamp"]).toStrictEqual("2026-03-01T12:00:02.000Z");
});
