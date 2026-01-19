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
    timeZone: "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 1000000,
    aiMaxInputChars: 500,
    aiEnableUwu: false,
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

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    lastRequest = { url, body };

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
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
// createAiService - API Request Structure (GPT-5 Nano compatibility)
// =============================================================================

Deno.test("generateReply sends correct model name (gpt-4o-mini)", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: "Test response" } }],
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    assertEquals(request?.body.model, "gpt-4o-mini");
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply uses max_tokens parameter", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: "Test response" } }],
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    // gpt-4o-mini uses standard max_tokens
    assertEquals(request?.body.max_tokens, 150);
  } finally {
    mock.restore();
  }
});

Deno.test("generateReply sends temperature parameter", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: "Test response" } }],
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig();
    const service = createAiService(config);

    await service.generateReply([{ author: "user", content: "hello" }]);

    const request = mock.getLastRequest();
    // gpt-4o-mini supports temperature
    assertEquals(request?.body.temperature, 0.7);
  } finally {
    mock.restore();
  }
});

// =============================================================================
// createAiService - Input Processing
// =============================================================================

Deno.test("generateReply truncates long input messages", async () => {
  const mock = mockFetch({
    choices: [{ message: { content: "Test response" } }],
    usage: { total_tokens: 50 },
  });

  try {
    const config = createMockConfig({ aiMaxInputChars: 20 });
    const service = createAiService(config);

    const longMessage = "This is a very long message that should be truncated";
    await service.generateReply([{ author: "user", content: longMessage }]);

    const request = mock.getLastRequest();
    const messages = request?.body.messages as Array<{ content: string }>;
    const userMessage = messages?.[messages.length - 1];
    // The truncated message should contain "..." (truncation happened)
    assertStringIncludes(userMessage?.content ?? "", "...");
    // And should NOT contain the full message
    assertEquals(userMessage?.content?.includes("should be truncated"), false);
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
    choices: [{ message: { content: "That sounds like a great idea!" } }],
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
    choices: [{ message: { content: "That sounds fun!" } }],
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
