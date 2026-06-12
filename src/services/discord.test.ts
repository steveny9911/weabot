import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDiscordClient } from "./discord.ts";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { restore: () => void } {
  const original_fetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original_fetch;
    },
  };
}

Deno.test("getRecentMessages clamps limit and maps Discord message payloads", async () => {
  let requested_url = "";
  const fetch_mock = mockFetch((url) => {
    requested_url = url;
    return new Response(
      JSON.stringify([
        {
          id: "msg-1",
          content: "hello",
          timestamp: "2026-06-11T20:00:00.000Z",
          author: {
            id: "user-1",
            username: "alice",
            global_name: "Alice",
            bot: false,
          },
          attachments: [
            {
              url: "https://cdn.example.com/a.png",
              content_type: "image/png",
            },
            {
              url: "https://cdn.example.com/not-image.txt",
              content_type: "text/plain",
            },
          ],
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  try {
    const discord = createDiscordClient("token");
    const messages = await discord.getRecentMessages("channel-1", 500);

    assertStringIncludes(requested_url, "/channels/channel-1/messages?limit=100");
    assertEquals(messages, [
      {
        id: "msg-1",
        authorId: "user-1",
        authorName: "Alice",
        authorBot: false,
        content: "hello",
        timestamp: "2026-06-11T20:00:00.000Z",
        imageUrls: ["https://cdn.example.com/a.png"],
      },
    ]);
  } finally {
    fetch_mock.restore();
  }
});

Deno.test("getRecentMessages returns an empty array for Discord errors", async () => {
  const fetch_mock = mockFetch(() => new Response("nope", { status: 403 }));

  try {
    const discord = createDiscordClient("token");
    const messages = await discord.getRecentMessages("channel-1", 20);
    assertEquals(messages, []);
  } finally {
    fetch_mock.restore();
  }
});
