import { assertEquals } from "@std/assert";
import { getContext, saveContext } from "./bot_actions.ts";
import type { AppConfig } from "./src/config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "test-channel",
    channelIds: ["test-channel"],
    timeZone: "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    ...overrides,
  };
}

function mockFetchMessages(
  messages: Array<Record<string, unknown>>,
): { restore: () => void } {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

Deno.test("saveContext stores image attachment URLs in context", async () => {
  const channel_id = "channel-images-1";
  const config = createMockConfig();
  const mock = mockFetchMessages([
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
      created_at: "2026-03-01T00:00:00.000Z",
    },
  ]);

  try {
    await saveContext(config, channel_id, 5);
    const ctx = getContext(channel_id) ?? [];

    assertEquals(ctx.length, 1);
    assertEquals(ctx[0]["imageUrls"], ["https://cdn.discordapp.com/attachments/1/2/cat.png"]);
  } finally {
    mock.restore();
  }
});

Deno.test("saveContext treats image by filename/size hints even without content_type", async () => {
  const channel_id = "channel-images-2";
  const config = createMockConfig();
  const mock = mockFetchMessages([
    {
      id: "m2",
      content: "",
      author: { id: "u2", username: "bob" },
      attachments: [
        {
          url: "https://media.discordapp.net/attachments/3/4/dog.jpg",
          filename: "dog.jpg",
        },
        {
          url: "https://cdn.discordapp.com/attachments/3/4/not-image.bin",
          filename: "not-image.bin",
          width: 1200,
          height: 800,
        },
      ],
      created_at: "2026-03-01T00:00:01.000Z",
    },
  ]);

  try {
    await saveContext(config, channel_id, 5);
    const ctx = getContext(channel_id) ?? [];

    assertEquals(ctx.length, 1);
    assertEquals(ctx[0]["imageUrls"], [
      "https://media.discordapp.net/attachments/3/4/dog.jpg",
      "https://cdn.discordapp.com/attachments/3/4/not-image.bin",
    ]);
  } finally {
    mock.restore();
  }
});
