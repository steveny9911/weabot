/**
 * Tests for AI Service
 *
 * Uses fetch mocking to verify API payload structure without making real calls.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createAiService, generateReplyFromMessages } from "./ai_service.ts";
import type { AppConfig } from "./src/config.ts";

// Helper to create a mock config
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
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 30,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
}

// Helper to mock fetch and capture the request
function mockFetch(
  responseBody: Record<string, unknown>,
  status = 200,
): {
  restore: () => void;
  getLastRequest: () => { url: string; body: Record<string, unknown> } | null;
} {
  let lastRequest: { url: string; body: Record<string, unknown> } | null = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    lastRequest = { url, body };

    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getLastRequest: () => lastRequest,
  };
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = Deno.env.get(key);
  }

  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

// =============================================================================
// createAiService - Configuration Checks
// =============================================================================

Deno.test("generateReply returns error when AI is disabled", async () => {
  const config = createMockConfig({ aiEnabled: false });
  const service = createAiService(config);

  const result = await service.generateReply([{ author: "user", content: "hello" }]);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "AI is disabled");
  }
});

Deno.test("generateReply returns error when API key is missing", async () => {
  const config = createMockConfig({ openaiApiKey: undefined });
  const service = createAiService(config);

  const result = await service.generateReply([{ author: "user", content: "hello" }]);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "OPENAI_API_KEY not set");
  }
});

// =============================================================================
// createAiService - API Request Structure (GPT-5.2 chat builder prompt)
// =============================================================================

Deno.test("generateReply sends correct model name (gpt-5.2-chat-latest)", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.model, "gpt-5.2-chat-latest");
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply sends chat builder prompt id without pinning version", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.prompt, {
      id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
    });
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply sends text format and store settings", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.text, { format: { type: "text" } });
    assertEquals(request?.body.store, true);
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply does not send max_tokens parameter", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.max_tokens, undefined);
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply does not send temperature parameter", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.temperature, undefined);
  } finally {
    mock.restore();
  }
});

// =============================================================================
// createAiService - Input Processing
// =============================================================================

Deno.test("generateReply does not truncate input when limits are disabled", async () => {
  const mock = mockFetch({
    output_text: "Test response",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig({ aiMaxInputChars: 0 });
    const service = createAiService(config);

    const longMessage = "This is a very long message that should not be truncated";
    await service.generateReply([{ author: "user", content: longMessage }]);

    const request = mock.getLastRequest();
    const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const first_message = input?.[0];
    const content_parts = first_message?.content ?? [];
    const text_part = content_parts.find((part) => part["type"] === "input_text");
    const text = (text_part?.["text"] as string | undefined) ?? "";

    assertStringIncludes(text, longMessage);
    assertEquals(text.includes("..."), false);
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply includes image URLs as input_image blocks", async () => {
  const mock = mockFetch({
    output_text: "Looks great!",
    usage: { total_tokens: 60 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([
      {
        author: "alice",
        content: "check this out",
        imageUrls: [
          "https://cdn.discordapp.com/attachments/1/2/cat.png",
          "not-a-url",
        ],
      },
      {
        author: "bob",
        content: "and this one too",
        imageUrls: [
          "https://media.discordapp.net/attachments/3/4/dog.jpg",
          "https://cdn.discordapp.com/attachments/1/2/cat.png",
        ],
      },
    ]);

    const request = mock.getLastRequest();
    const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const content_parts = input?.[0]?.content ?? [];
    const image_parts = content_parts.filter((part) => part["type"] === "input_image");

    assertEquals(image_parts.length, 2);
    assertEquals(image_parts[0]["image_url"], "https://cdn.discordapp.com/attachments/1/2/cat.png");
    assertEquals(
      image_parts[1]["image_url"],
      "https://media.discordapp.net/attachments/3/4/dog.jpg",
    );
  } finally {
    mock.restore();
  }
});

// =============================================================================
// createAiService - Response Handling
// =============================================================================

Deno.test("generateReply returns success with text and token count", async () => {
  const mock = mockFetch({
    // Use text that won't be stripped by the greeting sanitizer
    output_text: "That sounds like a great idea!",
    usage: { total_tokens: 75 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.text, "That sounds like a great idea!");
      assertEquals(result.tokensUsed, 75);
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply extracts text from structured output content", async () => {
  const mock = mockFetch({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Structured response text" },
        ],
      },
    ],
    usage: { total_tokens: 61 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.text, "Structured response text");
      assertEquals(result.tokensUsed, 61);
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply extracts text when content text uses value shape", async () => {
  const mock = mockFetch({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: { value: "Value-shaped text" } },
        ],
      },
    ],
    usage: { total_tokens: 62 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.text, "Value-shaped text");
      assertEquals(result.tokensUsed, 62);
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply returns explicit error when response has no extractable text", async () => {
  const mock = mockFetch({
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }],
    usage: { total_tokens: 30 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error, "No text in OpenAI response");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply handles API error response", async () => {
  const mock = mockFetch(
    { error: { message: "Invalid request" } },
    400,
  );

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "400");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply applies UwU transformation when enabled", async () => {
  const mock = mockFetch({
    // Use text that won't be stripped by the greeting sanitizer
    output_text: "That sounds fun!",
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig({ aiEnableUwu: true });
    const service = createAiService(config);

    const result = await service.generateReply([{ author: "user", content: "hi" }]);

    assertEquals(result.ok, true);
    if (result.ok) {
      // Short replies with ! should get !~ and uwu
      assertStringIncludes(result.text, "!~");
      assertStringIncludes(result.text, "uwu");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply truncates input when aiMaxInputChars is set", async () => {
  const mock = mockFetch({
    output_text: "ok",
    usage: { total_tokens: 20 },
  });

  try {
    const config = createMockConfig({ aiMaxInputChars: 10 });
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "this is definitely too long" }]);

    const request = mock.getLastRequest();
    const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const textPart = input?.[0]?.content?.find((part) => part["type"] === "input_text");
    const text = String(textPart?.["text"] ?? "");
    assertStringIncludes(text, "this is...");
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply sanitizes greetings and apology phrasing", async () => {
  const mock = mockFetch({
    output_text: "Hello there, I'm sorry I cannot do that!",
    usage: { total_tokens: 22 },
  });

  try {
    const service = createAiService(createMockConfig());
    const result = await service.generateReply([{ author: "user", content: "help" }]);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.text, "do that!");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply returns error when fetch throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.reject(new Error("network down"));
  }) as typeof fetch;

  try {
    const service = createAiService(createMockConfig());
    const result = await service.generateReply([{ author: "user", content: "hello" }]);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error, "network down");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("generateReplyFromMessages uses env config and returns legacy success shape", async () => {
  const mock = mockFetch({
    output_text: "Legacy works",
    usage: { total_tokens: 30 },
  });

  try {
    await withEnv(
      {
        OPENAI_API_KEY: "sk-env",
        DISCORD_TOKEN: "discord-env",
        CHANNEL_IDS: "chan-1, chan-2",
        CHANNEL_ID: "fallback-chan",
        ENABLE_UWU: "false",
        WEB_SEARCH_ENABLED: "true",
        BRAVE_SEARCH_API_KEY: "brave-env",
        WEB_SEARCH_MAX_RESULTS: "7",
        LINK_OPEN_ENABLED: "true",
      },
      async () => {
        const result = await generateReplyFromMessages([{ author: "user", content: "hello" }]);
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.text, "Legacy works");
        }

        const request = mock.getLastRequest();
        assertEquals(request?.body.model, "gpt-5.2-chat-latest");
      },
    );
  } finally {
    mock.restore();
  }
});

Deno.test("generateReplyFromMessages returns error when OPENAI_API_KEY is missing", async () => {
  await withEnv(
    {
      OPENAI_API_KEY: undefined,
      BRAVE_SEARCH_API_KEY: undefined,
      WEB_SEARCH_ENABLED: undefined,
      CHANNEL_IDS: undefined,
      CHANNEL_ID: undefined,
      DISCORD_TOKEN: undefined,
      ENABLE_UWU: undefined,
      WEB_SEARCH_MAX_RESULTS: undefined,
      LINK_OPEN_ENABLED: undefined,
    },
    async () => {
      const result = await generateReplyFromMessages([{ author: "user", content: "hi" }]);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error, "OPENAI_API_KEY not set");
      }
    },
  );
});

Deno.test("generateReply handles malformed output shapes without extractable text", async () => {
  {
    const mock = mockFetch({
      output: "not-an-array",
    });
    try {
      const service = createAiService(createMockConfig());
      const result = await service.generateReply([{ author: "user", content: "hi" }]);
      assertEquals(result, { ok: false, error: "No text in OpenAI response" });
    } finally {
      mock.restore();
    }
  }

  {
    const mock = mockFetch({
      output: [
        null,
        "bad-item",
        { content: "not-array" },
        { content: [null, { type: "output_text", text: "" }] },
      ],
    });
    try {
      const service = createAiService(createMockConfig());
      const result = await service.generateReply([{ author: "user", content: "hi" }]);
      assertEquals(result, { ok: false, error: "No text in OpenAI response" });
    } finally {
      mock.restore();
    }
  }
});

Deno.test("generateReply caps image inputs to six unique URLs and ignores non-strings", async () => {
  const mock = mockFetch({
    output_text: "ok",
    usage: { total_tokens: 40 },
  });

  try {
    const service = createAiService(createMockConfig());
    await service.generateReply([
      {
        author: "a",
        content: "x",
        imageUrls: [
          "https://example.com/1.png",
          "https://example.com/2.png",
          123,
          "https://example.com/3.png",
          "https://example.com/4.png",
          "https://example.com/5.png",
          "https://example.com/6.png",
          "https://example.com/7.png",
        ],
      },
    ]);

    const request = mock.getLastRequest();
    const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const image_parts = input?.[0]?.content?.filter((part) => part["type"] === "input_image") ??
      [];
    assertEquals(image_parts.length, 6);
    assertEquals(
      image_parts[5]["image_url"],
      "https://example.com/6.png",
    );
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply falls back to unknown author/content and zero token usage", async () => {
  const mock = mockFetch({
    output_text: "Works",
  });

  try {
    const service = createAiService(createMockConfig());
    const result = await service.generateReply([{}]);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.tokensUsed, 0);
    }

    const request = mock.getLastRequest();
    const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const textPart = input?.[0]?.content?.find((part) => part["type"] === "input_text");
    assertStringIncludes(String(textPart?.["text"] ?? ""), "unknown: ");
  } finally {
    mock.restore();
  }
});

Deno.test("generateReplyFromMessages supports CHANNEL_ID fallback when CHANNEL_IDS is missing", async () => {
  const mock = mockFetch({
    output_text: "fallback works",
    usage: { total_tokens: 15 },
  });

  try {
    await withEnv(
      {
        OPENAI_API_KEY: "sk-env",
        CHANNEL_IDS: undefined,
        CHANNEL_ID: "chan-fallback",
        BRAVE_SEARCH_API_KEY: undefined,
        WEB_SEARCH_ENABLED: undefined,
      },
      async () => {
        const result = await generateReplyFromMessages([{ author: "user", content: "hello" }]);
        assertEquals(result.ok, true);
      },
    );
  } finally {
    mock.restore();
  }
});
