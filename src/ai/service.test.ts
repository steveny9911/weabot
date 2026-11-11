import { expect, test } from "bun:test";
import { withResponses } from "../../tests/support/openai.ts";
import { assert } from "../../tests/support/assert.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "./participation.ts";
import { reactionChoices } from "../features/reactions.ts";
import { createAiService } from "./service.ts";
import type { AiParticipationOptions } from "./types.ts";
import type { AppConfig } from "../config.ts";
import {
  mapDiscordMessage,
  toAiContextMessage,
  selectActiveConversation,
} from "../features/chat_context.ts";
import { testConfig } from "../../tests/support/config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    timeZone: "America/Los_Angeles",
    aiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    ...overrides,
  });
}

/**
 * Answers one generateReply call with `body` (as OpenAI would) and returns
 * the result and the request sent.
 */
async function generate(
  body: Record<string, unknown>,
  {
    status = 200,
    config = createMockConfig(),
    messages = [{ author: "user", content: "hi" }],
    options,
  }: {
    status?: number;
    config?: AppConfig;
    messages?: Array<Record<string, unknown>>;
    options?: unknown;
  } = {},
) {
  return withResponses([Response.json(body, { status })], async (requests) => ({
    result: await createAiService(config).generateReply(messages, options as never),
    request: { body: requests[0] },
  }));
}

test("generateReply returns error when AI is disabled", async () => {
  const config = createMockConfig({ aiEnabled: false });
  const service = createAiService(config);

  const result = await service.generateReply([{ author: "user", content: "hello" }]);

  expect(result.ok).toStrictEqual(false);
  if (!result.ok) {
    expect(result.error).toStrictEqual("AI is disabled");
  }
});

test("generateReply returns error when API key is missing", async () => {
  const config = createMockConfig({ aiApiKey: undefined });
  const service = createAiService(config);

  const result = await service.generateReply([{ author: "user", content: "hello" }]);

  expect(result.ok).toStrictEqual(false);
  if (!result.ok) {
    expect(result.error).toStrictEqual("OPENAI_API_KEY not set");
  }
});

test("generateReply sends chat builder prompt id without pinning version", async () => {
  const { request } = await generate(
    { output_text: "Test response", usage: { total_tokens: 50 } },
    { messages: [{ author: "user", content: "hello" }] },
  );
  expect(request?.body.prompt).toStrictEqual({
    id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
  });
});
test("generateReply tells the model to use web reference notes", async () => {
  const ok = { output_text: "ok", usage: { total_tokens: 5 } };
  await withResponses([ok, ok], async (requests) => {
    const service = createAiService(createMockConfig());
    await service.generateReply([{ author: "user", content: "who won?" }]);
    expect(JSON.stringify(requests[0])).not.toContain("reference notes");

    await service.generateReply([
      { author: "user", content: "who won?" },
      { author: "web", content: "Reference notes: Verstappen won" },
    ]);
    expect(JSON.stringify(requests[1])).toContain("use them to answer");
  });
});

test("generateReply includes image URLs as input_image blocks", async () => {
  const { request } = await generate(
    { output_text: "Looks great!", usage: { total_tokens: 60 } },
    {
      messages: [
        {
          author: "alice",
          content: "check this out",
          imageUrls: ["https://cdn.discordapp.com/attachments/1/2/cat.png", "not-a-url"],
        },
        {
          author: "bob",
          content: "and this one too",
          imageUrls: [
            "https://media.discordapp.net/attachments/3/4/dog.jpg",
            "https://cdn.discordapp.com/attachments/1/2/cat.png",
          ],
        },
      ],
    },
  );

  const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const contentParts = input?.[0]?.content ?? [];
  const imageParts = contentParts.filter((part) => part["type"] === "input_image");

  expect(imageParts.length).toStrictEqual(2);
  expect(imageParts[0]["image_url"]).toStrictEqual(
    "https://cdn.discordapp.com/attachments/1/2/cat.png",
  );
  expect(imageParts[1]["image_url"]).toStrictEqual(
    "https://media.discordapp.net/attachments/3/4/dog.jpg",
  );
});

test("generateReply includes explicit Discord reply references in text and images", async () => {
  const { request } = await generate(
    { output_text: "I remember", usage: { total_tokens: 25 } },
    {
      messages: [
        {
          author: "alice",
          content: "this one",
          repliedTo: {
            author: "bob",
            content: "the old topic",
            imageUrls: ["https://cdn.discordapp.com/old-topic.png"],
          },
        },
      ],
    },
  );

  const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const contentParts = input?.[0]?.content ?? [];
  const textPart = contentParts.find((part) => part["type"] === "input_text");
  const imageParts = contentParts.filter((part) => part["type"] === "input_image");

  expect(String(textPart?.["text"])).toContain(
    "alice (replying to bob: the old topic [attached 1 image]): this one",
  );
  expect(imageParts).toStrictEqual([
    {
      type: "input_image",
      image_url: "https://cdn.discordapp.com/old-topic.png",
    },
  ]);
});

test("generateReply returns success with text and token count", async () => {
  const { result } = await generate({
    // Use text that won't be stripped by the greeting sanitizer
    output_text: "That sounds like a great idea!",
    usage: { total_tokens: 75 },
  });

  assert(result.ok);
  expect(result.text).toContain("That sounds like a great idea!");
  expect(result.tokensUsed).toStrictEqual(75);
});

test("generateReply extracts text from structured output content", async () => {
  const { result } = await generate({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Structured response text" }],
      },
    ],
    usage: { total_tokens: 61 },
  });

  assert(result.ok);
  expect(result.text).toContain("Structured response text");
  expect(result.tokensUsed).toStrictEqual(61);
});
test("generateReply returns explicit error when response has no extractable text", async () => {
  const { result } = await generate({
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }],
    usage: { total_tokens: 30 },
  });

  assert(!result.ok);
  expect(result.error).toStrictEqual("No text in OpenAI response");
});

test("generateReply handles API error response", async () => {
  const { result } = await generate({ error: { message: "Invalid request" } }, { status: 400 });

  assert(!result.ok);
  expect(result.error).toContain("400");
});

test("generateReply applies UwU transformation when enabled", async () => {
  const { result } = await generate(
    { output_text: "That sounds fun!", usage: { total_tokens: 50 } },
    { config: createMockConfig({ aiEnableUwu: true }) },
  );

  assert(result.ok);
  // Short replies with ! should get !~ and uwu
  expect(result.text).toContain("!~");
  expect(result.text).toContain("uwu");
});

test("generateReply truncates input when aiMaxInputChars is set", async () => {
  const { request } = await generate(
    { output_text: "ok", usage: { total_tokens: 20 } },
    {
      config: createMockConfig({ aiMaxInputChars: 10 }),
      messages: [{ author: "user", content: "this is definitely too long" }],
    },
  );

  const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const textPart = input?.[0]?.content?.find((part) => part["type"] === "input_text");
  const text = String(textPart?.["text"] ?? "");
  expect(text).toContain("this is...");
});

test("generateReply drops a leading greeting but keeps the meaning and a greeting-only reply", async () => {
  for (const [reply, expected] of [
    ["Hello there, I'm sorry I cannot do that!", "I'm sorry I cannot do that!"],
    ["Hi there!", "Hi there!"],
  ]) {
    const { result } = await generate(
      { output_text: reply, usage: { total_tokens: 22 } },
      { messages: [{ author: "user", content: "help" }] },
    );
    expect(result.ok && result.text).toStrictEqual(expected);
  }
});
test("a reply to a video cannot poison subsequent text-only AI requests", async () => {
  const messages = [
    {
      id: "first-mention",
      content: "Do not drink that",
      timestamp: "2026-10-05T12:00:00Z",
      author: { username: "Alice" },
      referenced_message: {
        content: "The pond",
        author: { username: "Bob" },
        attachments: [
          {
            url: "https://cdn.example.com/pond.mov",
            filename: "pond.mov",
            content_type: "video/quicktime",
            width: 640,
            height: 360,
          },
        ],
      },
    },
    {
      id: "follow-up",
      content: "Are you okay?",
      timestamp: "2026-10-05T12:00:20Z",
      author: { username: "Alice" },
    },
  ];

  const context = selectActiveConversation(messages.map(mapDiscordMessage), {
    maxMessages: 40,
    inactivityGapMs: 20 * 60_000,
  }).map(toAiContextMessage);
  const { result, request } = await generate(
    { output_text: "Still here!", usage: { total_tokens: 12 } },
    { messages: context },
  );

  assert(result.ok);
  const input = request?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
  expect(input[0].content.filter((part) => part.type === "input_image")).toStrictEqual([]);
  expect(String(input[0].content[0].text)).toContain("replying to Bob: The pond");
  expect(String(input[0].content[0].text)).toContain("Are you okay?");
});

const participationMessages = [
  { id: "100", author: "alice", content: "A very good horse meme" },
  { id: "101", author: "bob", content: "That one got me" },
];

const participationOptions: AiParticipationOptions = {
  mode: "autonomous",
  instructions: "You are joining the memes channel. Keep it natural and occasional.",
  allowedMessageIds: ["100", "101"],
  reactionChoices: reactionChoices(null, undefined, () => 0),
};

function choice(action: string, text = "", messageId = "", emoji = ""): string {
  const intent =
    participationOptions.reactionChoices.find((option) => option.emoji === emoji)?.intent ?? "";
  const reason = action === "react" ? "acknowledgment" : "no_contribution";
  return JSON.stringify({ action, text, messageId, emoji, intent, reason });
}

test("autonomous participation uses developer guidance, context IDs, strict JSON, and no tools", async () => {
  let executions = 0;
  const { request } = await generate(
    { output_text: choice("silent"), usage: { total_tokens: 15 } },
    {
      messages: participationMessages,
      options: {
        ...participationOptions,
        // Even accidentally supplied action capabilities must not cross this boundary.
        tools: [{ type: "function", name: "create_event" }],
        currentUserMessage: "Create an event.",
        executeTool: () => {
          executions++;
          return Promise.resolve({ ok: true });
        },
      },
    },
  );

  const body = request!.body;
  expect(body.prompt).toStrictEqual({
    id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
  });
  expect(body.model).toStrictEqual(undefined);
  expect(body.tools).toStrictEqual(undefined);
  expect(body.tool_choice).toStrictEqual("none");
  expect(body.parallel_tool_calls).toStrictEqual(undefined);
  expect(executions).toStrictEqual(0);
  expect(body.text).toStrictEqual({ format: AUTONOMOUS_PARTICIPATION_FORMAT });
  const input = body.input as Array<Record<string, unknown>>;
  expect(input.length).toStrictEqual(2);
  expect(input[0].role).toStrictEqual("developer");
  const guidance = String(input[0].content);
  expect(guidance).toContain(participationOptions.instructions);
  expect(guidance).toContain("Keep the persona from the saved prompt");
  expect(guidance).toContain('["100","101"]');
  for (const { emoji } of participationOptions.reactionChoices) expect(guidance).toContain(emoji);
  const content = input[1].content as Array<Record<string, unknown>>;
  expect(String(content[0].text)).toContain("[message ID: 100] alice:");
  expect(String(content[0].text)).toContain("[message ID: 101] bob:");
});

test("autonomous reply preserves its text without greeting removal or UwU rewriting", async () => {
  const text = "Hello there! I couldn't resist that horse joke.";
  const { result } = await generate(
    {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: choice("reply", text) }],
        },
      ],
      status: "completed",
      usage: { total_tokens: 30 },
    },
    {
      config: createMockConfig({ aiEnableUwu: true }),
      messages: participationMessages,
      options: participationOptions,
    },
  );

  expect(result).toStrictEqual({
    ok: true,
    text,
    tokensUsed: 30,
    requestsUsed: 1,
    participation: { action: "reply", text, reason: "no_contribution" },
  });
});

test("autonomous reactions accept each supplied choice and return no fallback text", async () => {
  for (const { emoji, intent } of participationOptions.reactionChoices) {
    const { result } = await generate(
      { output_text: choice("react", "", "100", emoji), usage: { total_tokens: 25 } },
      {
        config: createMockConfig({ aiEnableUwu: true }),
        messages: participationMessages,
        options: participationOptions,
      },
    );

    expect(result).toStrictEqual({
      ok: true,
      text: "",
      tokensUsed: 25,
      requestsUsed: 1,
      participation: {
        action: "react",
        messageId: "100",
        emoji,
        intent,
        reason: "acknowledgment",
      },
    });
  }
});
test("autonomous replies enforce the 280-character boundary without truncating into chatter", async () => {
  for (const length of [280, 281]) {
    const text = "x".repeat(length);
    const { result } = await generate(
      { output_text: choice("reply", text), usage: { total_tokens: 29 } },
      { messages: participationMessages, options: participationOptions },
    );

    expect(result).toStrictEqual(
      length === 280
        ? {
            ok: true,
            text,
            tokensUsed: 29,
            requestsUsed: 1,
            participation: { action: "reply", text, reason: "no_contribution" },
          }
        : {
            ok: true,
            text: "",
            tokensUsed: 29,
            requestsUsed: 1,
            participation: { action: "silent" },
          },
    );
  }
});

test("autonomous invalid choices fail closed for content, targets, emojis, and mixed actions", async () => {
  const invalid = [
    "I'll just laugh along!",
    "```json\n" + choice("react", "", "100", "😂") + "\n```",
    "{",
    "null",
    "[]",
    choice("send", "Not an allowed action"),
    choice("reply"),
    choice("reply", "   "),
    choice("reply", "A comment", "100", "😂"),
    choice("react", "Extra chatter", "100", "😂"),
    choice("react", "", "999", "😂"),
    choice("react", "", "100", "😈"),
    choice("react", "", "100", "<:horse:123>"),
    choice("react", "", "100", "😂 😂"),
    choice("react", "", "100", "❤"),
    choice("silent", "Explaining why I'm silent"),
    // Otherwise valid, but with an extra field, and with a number where a string belongs.
    JSON.stringify({ ...JSON.parse(choice("react", "", "100", "😂")), extra: true }),
    JSON.stringify({ ...JSON.parse(choice("react", "", "100", "😂")), messageId: 100 }),
    JSON.stringify({ action: "silent" }),
  ];
  for (const outputText of invalid) {
    const { result } = await generate(
      { output_text: outputText, usage: { total_tokens: 21 } },
      { messages: participationMessages, options: participationOptions },
    );

    // The case is part of the compared value so a failure shows which output_text broke.
    expect({ output_text: outputText, result }).toStrictEqual({
      output_text: outputText,
      result: {
        ok: true,
        text: "",
        tokensUsed: 21,
        requestsUsed: 1,
        participation: { action: "silent" },
      },
    });
  }
});

test("autonomous reactions require targets present in both allowed IDs and the actual context", async () => {
  const { result, request } = await generate(
    { output_text: choice("react", "", "999", "😂"), usage: { total_tokens: 9 } },
    {
      messages: participationMessages,
      options: { ...participationOptions, allowedMessageIds: ["999"] },
    },
  );

  expect(result).toStrictEqual({
    ok: true,
    text: "",
    tokensUsed: 9,
    requestsUsed: 1,
    participation: { action: "silent" },
  });
  const input = request!.body.input as Array<Record<string, unknown>>;
  expect(String(input[0].content)).toContain("select a messageId from []");
});

test("autonomous empty, incomplete, refused, and unexpected outputs remain silent with usage", async () => {
  const validChoice = choice("reply", "This text must not be sent.");
  const payloads = [
    { output_text: "" },
    { output: "unexpected" },
    { output: [null] },
    { output_text: validChoice, status: "incomplete" },
    { output_text: validChoice, status: "failed" },
    { output_text: validChoice, status: "in_progress" },
    {
      output_text: validChoice,
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }],
    },
    {
      output_text: validChoice,
      output: [{ type: "function_call", name: "create_event", call_id: "call1", arguments: "{}" }],
    },
    {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: validChoice }],
        },
      ],
    },
  ];
  for (const payload of payloads) {
    const { result } = await generate(
      { ...payload, usage: { total_tokens: 19 } },
      { messages: participationMessages, options: participationOptions },
    );

    expect(result).toStrictEqual({
      ok: true,
      text: "",
      tokensUsed: 19,
      requestsUsed: 1,
      participation: { action: "silent" },
    });
  }
});
test("autonomous custom emotes require the exact supplied intent and expression", async () => {
  const options = {
    ...participationOptions,
    reactionChoices: [
      {
        emoji: "BocchiSip:123",
        intent: "dry_amusement" as const,
        description: "Quiet sipping at harmless absurdity",
      },
    ],
  };
  for (const [emoji, intent, reason, accepted] of [
    ["BocchiSip:123", "dry_amusement", "shared_joke", true],
    ["BocchiSip:999", "dry_amusement", "shared_joke", false],
    ["BocchiSip:123", "amusement", "shared_joke", false],
    ["BocchiSip:123", "dry_amusement", "unkindness", false],
    ["BocchiSip:123", "dry_amusement", "unbounded reason text", false],
  ] as const) {
    const { result } = await generate(
      {
        output_text: JSON.stringify({
          action: "react",
          text: "",
          messageId: "100",
          emoji,
          intent,
          reason,
        }),
      },
      { messages: participationMessages, options },
    );

    assert(result.ok);
    expect(result.participation?.action).toStrictEqual(accepted ? "react" : "silent");
  }
});
