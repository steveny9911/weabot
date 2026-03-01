/**
 * Tests for AI Service
 *
 * Uses fetch mocking to verify API payload structure without making real calls.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createAiService } from "./ai_service.ts";
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
    ...overrides,
  };
}

// Helper to mock fetch and capture the request
function mockFetch(
  responseBody: Record<string, unknown>,
  status = 200,
): { restore: () => void; getLastRequest: () => { url: string; body: Record<string, unknown> } | null } {
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
    assertEquals(image_parts[1]["image_url"], "https://media.discordapp.net/attachments/3/4/dog.jpg");
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
