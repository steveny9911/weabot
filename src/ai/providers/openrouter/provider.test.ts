import { expect, test } from "bun:test";
import { testConfig } from "../../../../tests/support/config.ts";
import { throws } from "../../../../tests/support/assert.ts";
import type { Fetcher } from "../../../types/fetch.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../../participation.ts";
import { createAiService } from "../../service.ts";
import { withResponses } from "../../../../tests/support/openai.ts";
import type { ProviderRequest } from "../types.ts";
import { openrouter } from "./index.ts";
import { createOpenRouterProvider, presetModel, type OpenRouterSettings } from "./provider.ts";

const settings = (overrides: Partial<OpenRouterSettings> = {}): OpenRouterSettings => ({
  preset: "haru-free",
  ...overrides,
});

const config = (overrides = {}) =>
  testConfig({
    aiProvider: "openrouter",
    aiApiKey: "or-key",
    aiProviderSettings: settings(),
    ...overrides,
  });

const reply = (text: string, total = 12) =>
  Response.json({
    model: "vendor/model:free",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { total_tokens: total },
  });

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  userText: "Alice: hi",
  imageUrls: [],
  format: "text",
  ...overrides,
});

/** Records the calls the provider makes and answers each with `respond`. */
function fakeFetch(respond: () => Response) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  };
  return { calls, fetcher };
}

test("a reply goes to the preset with the key, with no model, persona or storage settings", async () => {
  const { calls, fetcher } = fakeFetch(() => reply("Hi!", 42));
  const session = createOpenRouterProvider(settings(), "or-key", { fetch: fetcher }).start(
    request({
      instructions: "Be brief.",
      imageUrls: ["https://cdn.example/a.png"],
      currentUserMessage: "Alice: hello?",
    }),
  );
  expect(await session.step(AbortSignal.timeout(1000))).toStrictEqual({
    ok: true,
    text: "Hi!",
    toolCalls: [],
    tokens: 42,
  });
  expect(session.calls).toStrictEqual(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toStrictEqual("https://openrouter.ai/api/v1/responses");
  expect(calls[0]!.headers.get("authorization")).toStrictEqual("Bearer or-key");
  expect(calls[0]!.body).toStrictEqual({
    model: "@preset/haru-free",
    input: [
      { role: "developer", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Alice: hi" },
          { type: "input_image", image_url: "https://cdn.example/a.png" },
        ],
      },
      { role: "user", content: "Alice: hello?" },
    ],
    text: { format: { type: "text" } },
    tool_choice: "none",
  });
});

test("the preset may be a slug or @preset/slug", () => {
  expect(presetModel("haru")).toStrictEqual("@preset/haru");
  expect(presetModel(" @preset/haru-free ")).toStrictEqual("@preset/haru-free");
});

test("the ai.openrouter section needs a preset", () => {
  const secret = () => undefined;
  throws(() => openrouter.parseConfig(undefined, secret), Error, "ai.openrouter.preset");
  throws(() => openrouter.parseConfig({ preset: "  " }, secret), Error, "ai.openrouter.preset");
  expect(openrouter.parseConfig({ preset: " haru " }, secret)).toStrictEqual({ preset: "haru" });
});

test("an error response reports its status and body, and any tokens it names", async () => {
  const { fetcher } = fakeFetch(
    () =>
      new Response('{"error":{"message":"Preset \\"x\\" not found for this user.","code":404}}', {
        status: 404,
      }),
  );
  const step = await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
    .start(request())
    .step(AbortSignal.timeout(1000));
  expect(step).toMatchObject({ ok: false, tokens: 0 });
  expect(step.ok === false && step.error).toContain("OpenRouter error 404");
  expect(step.ok === false && step.error).toContain("not found for this user");
});

test("a response without text is reported as empty", async () => {
  const { fetcher } = fakeFetch(() => Response.json({ output: [], usage: { total_tokens: 3 } }));
  expect(
    await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
      .start(request())
      .step(AbortSignal.timeout(1000)),
  ).toStrictEqual({ ok: true, text: null, toolCalls: [], tokens: 3 });
});

test("reasoning text is not part of the reply", async () => {
  const { fetcher } = fakeFetch(() =>
    Response.json({
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "We need to answer." }] },
        { type: "message", content: [{ type: "output_text", text: "Hello!" }] },
      ],
    }),
  );
  expect(
    await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
      .start(request())
      .step(AbortSignal.timeout(1000)),
  ).toMatchObject({ ok: true, text: "Hello!" });
});

const tool = {
  type: "function",
  name: "create_event",
  description: "Create the requested event.",
  strict: true,
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
};

const functionCall = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: "create_event",
  arguments: '{"name":"Movie night"}',
});

const callResponse = (model = "vendor/model:free") =>
  Response.json({
    model,
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "hmm" }] },
      functionCall("call_1"),
    ],
    usage: { total_tokens: 30 },
  });

test("tool requests send the tools one call at a time, and the calls come back", async () => {
  const { calls, fetcher } = fakeFetch(() => callResponse());
  const session = createOpenRouterProvider(settings(), "or-key", { fetch: fetcher }).start(
    request({ tools: [tool] }),
  );
  expect(await session.step(AbortSignal.timeout(1000))).toStrictEqual({
    ok: true,
    text: null,
    toolCalls: [{ id: "call_1", name: "create_event", arguments: '{"name":"Movie night"}' }],
    tokens: 30,
  });
  expect(calls[0]!.body).toMatchObject({
    model: "@preset/haru-free",
    tools: [tool],
    parallel_tool_calls: false,
    text: { format: { type: "text" } },
  });
  expect(calls[0]!.body).not.toHaveProperty("tool_choice");
  expect(calls[0]!.body).not.toHaveProperty("provider");
});

test("tool results continue on the model that asked, with every output item kept", async () => {
  const responses = [callResponse("vendor/model:free"), reply("Done!", 9)];
  const { calls, fetcher } = fakeFetch(() => responses.shift()!);
  const session = createOpenRouterProvider(settings(), "or-key", { fetch: fetcher }).start(
    request({ tools: [tool] }),
  );
  const first = await session.step(AbortSignal.timeout(1000));
  expect(first.ok && first.toolCalls).toHaveLength(1);
  session.addToolResults(first.ok ? first.toolCalls : [], ['{"ok":true}']);
  expect(await session.step(AbortSignal.timeout(1000))).toMatchObject({ ok: true, text: "Done!" });
  expect(session.calls).toStrictEqual(2);
  expect(calls[0]!.body.model).toStrictEqual("@preset/haru-free");
  expect(calls[1]!.body.model).toStrictEqual("vendor/model:free@preset/haru-free");
  expect((calls[1]!.body.input as unknown[]).slice(-3)).toStrictEqual([
    { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "hmm" }] },
    functionCall("call_1"),
    { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
  ]);
});

test("an incomplete or failed tool response is an error that keeps its tokens", async () => {
  for (const status of ["incomplete", "failed"]) {
    const { fetcher } = fakeFetch(() =>
      Response.json({ status, output: [], usage: { total_tokens: 5 } }),
    );
    expect(
      await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
        .start(request({ tools: [tool] }))
        .step(AbortSignal.timeout(1000)),
    ).toStrictEqual({ ok: false, error: `OpenRouter response ${status}`, tokens: 5 });
  }
});

const decision = (overrides = {}) =>
  JSON.stringify({
    action: "reply",
    text: "Hello!",
    messageId: "",
    emoji: "",
    intent: "",
    reason: "natural_contribution",
    ...overrides,
  });

test("an autonomous decision asks for the strict format from endpoints that honor it", async () => {
  const { calls, fetcher } = fakeFetch(() => reply(decision(), 21));
  expect(
    await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
      .start(request({ format: "participation" }))
      .step(AbortSignal.timeout(1000)),
  ).toStrictEqual({ ok: true, text: decision(), toolCalls: [], tokens: 21 });
  expect(calls[0]!.body).toMatchObject({
    model: "@preset/haru-free",
    text: { format: AUTONOMOUS_PARTICIPATION_FORMAT },
    provider: { require_parameters: true },
    tool_choice: "none",
  });
});

test("a decision is only accepted from one completed assistant message", async () => {
  const output = (item: Record<string, unknown>) =>
    Response.json({ status: "completed", output: [item], usage: { total_tokens: 1 } });
  const message = { type: "message", role: "assistant", status: "completed" };
  const text = [{ type: "output_text", text: decision() }];
  for (const [body, expected] of [
    [() => output({ ...message, content: text }), decision()],
    [() => output({ ...message, status: "incomplete", content: text }), null],
    [() => output({ ...message, content: [{ type: "refusal", refusal: "no" }] }), null],
    [() => output({ type: "function_call", call_id: "c", name: "x", arguments: "{}" }), null],
    [() => Response.json({ status: "incomplete", output: [] }), null],
  ] as const) {
    const { fetcher } = fakeFetch(body);
    const step = await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
      .start(request({ format: "participation" }))
      .step(AbortSignal.timeout(1000));
    expect(step).toMatchObject({ ok: true, text: expected });
  }
});

test("a rejected decision request reports the tokens the error names", async () => {
  const { fetcher } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({ error: { message: "No endpoints found" }, usage: { total_tokens: 8 } }),
        {
          status: 404,
        },
      ),
  );
  const step = await createOpenRouterProvider(settings(), "or-key", { fetch: fetcher })
    .start(request({ format: "participation" }))
    .step(AbortSignal.timeout(1000));
  expect(step).toMatchObject({ ok: false, tokens: 8 });
  expect(step.ok === false && step.error).toContain("OpenRouter error 404");
});

test("the AI service runs a tool loop through the preset", async () => {
  const executions: unknown[] = [];
  const responses = [callResponse(), reply("Created it!", 11)];
  await withResponses(responses, async (requests) => {
    const result = await createAiService(config()).generateReply(
      [{ author: "Alice", content: "Create Movie night." }],
      {
        instructions: "Only do what is asked.",
        tools: [tool],
        executeTool: (name, args) => {
          executions.push({ name, args });
          return Promise.resolve({ ok: true });
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      text: "Created it!",
      tokensUsed: 41,
      requestsUsed: 2,
    });
    expect(requests[1]!.model).toStrictEqual("vendor/model:free@preset/haru-free");
  });
  expect(executions).toStrictEqual([{ name: "create_event", args: { name: "Movie night" } }]);
});

test("the AI service answers a mention through the OpenRouter preset", async () => {
  await withResponses([reply("Sure thing!", 7)], async (requests) => {
    const result = await createAiService(config()).generateReply([
      { author: "Alice", content: "hi" },
    ]);
    expect(result).toMatchObject({ ok: true, text: "Sure thing!", tokensUsed: 7 });
    expect(requests[0]).toMatchObject({ model: "@preset/haru-free", tool_choice: "none" });
  });
});

test("the AI service names OpenRouter when the key is missing or the call fails", async () => {
  expect(
    await createAiService(config({ aiApiKey: undefined })).generateReply([
      { author: "Alice", content: "hi" },
    ]),
  ).toMatchObject({ ok: false, error: "OPENROUTER_API_KEY not set" });
  await withResponses([new Response("busy", { status: 429 })], async () => {
    const result = await createAiService(config()).generateReply([
      { author: "Alice", content: "hi" },
    ]);
    expect(result.ok === false && result.error).toStrictEqual("OpenRouter error 429: busy");
  });
});
