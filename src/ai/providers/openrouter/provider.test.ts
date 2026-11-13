import { expect, test } from "bun:test";
import { throws } from "../../../../tests/support/assert.ts";
import { fakeFetch } from "../../../../tests/support/fake_fetch.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../../participation.ts";
import type { ProviderRequest } from "../types.ts";
import { openrouter } from "./index.ts";
import { createOpenRouterProvider, type OpenRouterSettings } from "./provider.ts";

const settings = (overrides: Partial<OpenRouterSettings> = {}): OpenRouterSettings => ({
  preset: "haru-free",
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

/** Runs one step of a fresh session against `respond`, and returns the step and the calls made. */
async function stepOnce(respond: () => Response, overrides: Partial<ProviderRequest> = {}) {
  const { calls, fetcher } = fakeFetch(respond);
  const session = createOpenRouterProvider(settings(), "or-key", { fetch: fetcher }).start(
    request(overrides),
  );
  return { step: await session.step(AbortSignal.timeout(1000)), calls };
}

test("a reply goes to the preset with the key, and sends no persona, model or storage", async () => {
  const { step, calls } = await stepOnce(() => reply("Hi!", 42), { instructions: "Be brief." });
  expect(step).toStrictEqual({ ok: true, text: "Hi!", toolCalls: [], tokens: 42 });
  expect(calls[0]!.url).toStrictEqual("https://openrouter.ai/api/v1/responses");
  expect(calls[0]!.headers.get("authorization")).toStrictEqual("Bearer or-key");
  expect(calls[0]!.body).toMatchObject({ model: "@preset/haru-free", tool_choice: "none" });
  expect(calls[0]!.body).not.toHaveProperty("store");
  expect(calls[0]!.body).not.toHaveProperty("prompt");
  expect(calls[0]!.body.input).toContainEqual({ role: "developer", content: "Be brief." });
});

test("the ai.openrouter section takes a slug or @preset/slug, and needs one", () => {
  const secret = () => undefined;
  expect(openrouter.parseConfig({ preset: " haru " }, secret)).toStrictEqual({ preset: "haru" });
  expect(openrouter.parseConfig({ preset: "@preset/haru" }, secret)).toStrictEqual({
    preset: "haru",
  });
  for (const section of [undefined, {}, { preset: "  " }, { preset: "@preset/" }, { preset: 5 }]) {
    throws(() => openrouter.parseConfig(section, secret), Error, "ai.openrouter.preset");
  }
});

test("an error response reports its status, body and any tokens it names", async () => {
  const body = JSON.stringify({ error: { message: "No endpoints" }, usage: { total_tokens: 8 } });
  for (const [format, tokens] of [
    ["text", 0],
    ["participation", 8],
  ] as const) {
    const { step } = await stepOnce(() => new Response(body, { status: 404 }), { format });
    expect(step).toMatchObject({ ok: false, tokens });
    expect(step.ok === false && step.error).toContain(`OpenRouter error 404: ${body}`);
  }
});

test("only message text is the reply: reasoning is skipped and a server tool is refused", async () => {
  const message = { type: "message", content: [{ type: "output_text", text: "Hello!" }] };
  const reasoning = { type: "reasoning", content: [{ type: "reasoning_text", text: "Thinking." }] };
  const run = (...output: unknown[]) =>
    stepOnce(() => Response.json({ output, usage: { total_tokens: 6 } }));
  expect((await run(reasoning, message)).step).toMatchObject({ ok: true, text: "Hello!" });
  const { step } = await run({ type: "openrouter:web_search" }, message);
  expect(step).toMatchObject({ ok: false, tokens: 6 });
  expect(step.ok === false && step.error).toContain("server tool");
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

test("tool results continue on the model that asked, with every output item kept", async () => {
  const responses = [callResponse("vendor/model:free"), reply("Done!", 9)];
  const { calls, fetcher } = fakeFetch(() => responses.shift()!);
  const session = createOpenRouterProvider(settings(), "or-key", { fetch: fetcher }).start(
    request({ tools: [tool] }),
  );
  const first = await session.step(AbortSignal.timeout(1000));
  expect(first).toMatchObject({
    ok: true,
    toolCalls: [{ id: "call_1", name: "create_event" }],
  });
  session.addToolResults(first.ok ? first.toolCalls : [], ['{"ok":true}']);
  expect(await session.step(AbortSignal.timeout(1000))).toMatchObject({ ok: true, text: "Done!" });
  expect(calls[0]!.body).toMatchObject({
    model: "@preset/haru-free",
    tools: [tool],
    parallel_tool_calls: false,
  });
  expect(calls[0]!.body).not.toHaveProperty("tool_choice");
  expect(calls[1]!.body.model).toStrictEqual("vendor/model:free@preset/haru-free");
  expect((calls[1]!.body.input as unknown[]).slice(-3)).toStrictEqual([
    { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "hmm" }] },
    functionCall("call_1"),
    { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
  ]);
});

test("an incomplete or failed tool response is an error that keeps its tokens", async () => {
  for (const status of ["incomplete", "failed"]) {
    const { step } = await stepOnce(
      () => Response.json({ status, output: [], usage: { total_tokens: 5 } }),
      { tools: [tool] },
    );
    expect(step).toStrictEqual({ ok: false, error: `OpenRouter response ${status}`, tokens: 5 });
  }
});

const decision = JSON.stringify({
  action: "reply",
  text: "Hello!",
  messageId: "",
  emoji: "",
  intent: "",
  reason: "natural_contribution",
});

test("an autonomous decision asks for the strict format from endpoints that honor it", async () => {
  const { step, calls } = await stepOnce(() => reply(decision, 21), { format: "participation" });
  expect(step).toStrictEqual({ ok: true, text: decision, toolCalls: [], tokens: 21 });
  expect(calls[0]!.body).toMatchObject({
    text: { format: AUTONOMOUS_PARTICIPATION_FORMAT },
    provider: { require_parameters: true },
    tool_choice: "none",
  });
});

test("a decision is only accepted from one completed assistant message", async () => {
  const message = { type: "message", role: "assistant", status: "completed" };
  const text = [{ type: "output_text", text: decision }];
  const output =
    (...items: unknown[]) =>
    () =>
      Response.json({ status: "completed", output: items, usage: { total_tokens: 1 } });
  for (const [respond, expected] of [
    [output({ ...message, content: text }), decision],
    [output({ ...message, status: "incomplete", content: text }), null],
    [output({ ...message, content: [{ type: "refusal", refusal: "no" }] }), null],
    [() => Response.json({ status: "incomplete", output: [] }), null],
  ] as const) {
    const { step } = await stepOnce(respond, { format: "participation" });
    expect(step).toMatchObject({ ok: true, text: expected });
  }
});
