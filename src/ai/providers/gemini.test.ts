import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, throws } from "../../../tests/support/assert.ts";
import { testConfig } from "../../../tests/support/config.ts";
import type { Fetcher } from "../../types/fetch.ts";
import { createAiService } from "../service.ts";
import { createGeminiProvider } from "./gemini.ts";
import { withProviderLimits } from "./index.ts";

let dir: string;
let promptFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-"));
  promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "You are Haru.\n");
});
afterEach(() => rmSync(dir, { recursive: true }));

const config = (overrides = {}) =>
  testConfig({
    aiProvider: "gemini",
    aiApiKey: "gemini-key",
    aiModel: "models/gemini-test",
    aiSystemPromptFile: promptFile,
    ...overrides,
  });

const reply = (text: string, total = 12) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: total },
    }),
    { headers: { "content-type": "application/json" } },
  );

interface GeminiBody {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: unknown[] }>;
}

/** Records Gemini calls and serves images by URL; anything else is the model reply. */
function fakeFetch(respond: () => Response, images: Record<string, Response> = {}) {
  const calls: Array<{ url: string; headers: Headers; body: GeminiBody }> = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    if (url in images) return images[url]!;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  };
  return { calls, fetcher };
}

const run = (fetcher: Fetcher, imageUrls: string[] = []) =>
  createGeminiProvider(config(), { fetch: fetcher })
    .start({ userText: "Alice: hi", imageUrls, format: "text" })
    .step(new AbortController().signal);

test("a plain reply sends the persona and the conversation to the model", async () => {
  const { calls, fetcher } = fakeFetch(() => reply("Hello!~"));
  const step = await run(fetcher);

  expect(step).toEqual({ ok: true, text: "Hello!~", toolCalls: [], tokens: 12 });
  const [call] = calls;
  assert(call);
  expect(call.url).toContain("models/gemini-test:generateContent");
  expect(call.headers.get("x-goog-api-key")).toBe("gemini-key");
  expect(call.body.systemInstruction.parts[0]?.text).toBe("You are Haru.");
  expect(call.body.contents).toEqual([{ role: "user", parts: [{ text: "Alice: hi" }] }]);
});

test("only PNG, JPEG and WebP images are sent, inline", async () => {
  const image = (type: string, size = 3) =>
    new Response(new Uint8Array(size), { headers: { "content-type": type } });
  const { calls, fetcher } = fakeFetch(() => reply("ok"), {
    "https://cdn/a.png": image("image/png"),
    "https://cdn/b.gif": image("image/gif"),
    "https://cdn/c.jpg": image("image/jpeg; charset=binary"),
    "https://cdn/big.webp": image("image/webp", 5_000_001),
    "https://cdn/gone.png": new Response("no", { status: 404 }),
  });
  await run(fetcher, [
    "https://cdn/a.png",
    "https://cdn/b.gif",
    "https://cdn/c.jpg",
    "https://cdn/big.webp",
    "https://cdn/gone.png",
  ]);

  const parts = calls[0]!.body.contents[0]!.parts;
  expect(parts).toEqual([
    { text: "Alice: hi" },
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
    { inlineData: { mimeType: "image/jpeg", data: "AAAA" } },
  ]);
});

test("thought parts are not part of the reply", async () => {
  const { fetcher } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "thinking...", thought: true }, { text: "Hi" }, { text: " there" }],
              },
            },
          ],
        }),
      ),
  );
  expect(await run(fetcher)).toMatchObject({ text: "Hi there", tokens: 0 });
});

test("a response without text is reported as empty", async () => {
  const { fetcher } = fakeFetch(
    () => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })),
  );
  expect(await run(fetcher)).toMatchObject({ ok: true, text: null });
});

test("a 429 is a quota error and is not retried", async () => {
  const { calls, fetcher } = fakeFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }), {
        status: 429,
      }),
  );
  const step = await run(fetcher);

  expect(step).toMatchObject({ ok: false, quotaExhausted: true });
  assert(!step.ok);
  expect(step.error).toContain("Gemini error 429");
  expect(calls).toHaveLength(1);
});

test("other API errors are not quota errors", async () => {
  const { fetcher } = fakeFetch(
    () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
  );
  const step = await run(fetcher);

  assert(!step.ok);
  expect(step.error).toContain("Gemini error 500");
  expect(step.quotaExhausted).toBeFalsy();
});

test("startup stops without a model, a prompt file, or prompt text", () => {
  throws(() => createGeminiProvider(config({ aiModel: undefined })), Error, "AI_MODEL");
  throws(
    () => createGeminiProvider(config({ aiSystemPromptFile: undefined })),
    Error,
    "AI_SYSTEM_PROMPT_FILE",
  );
  throws(
    () => createGeminiProvider(config({ aiSystemPromptFile: join(dir, "missing.md") })),
    Error,
    "missing.md",
  );
  writeFileSync(promptFile, "  \n");
  throws(() => createGeminiProvider(config()), Error, "is empty");
});

test("the service uses Gemini and reports a quota error to the caller", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response("{}", { status: 429 }), {
    preconnect() {},
  }) as typeof fetch;
  try {
    const result = await createAiService(config()).generateReply([
      { author: "Alice", content: "hi" },
    ]);
    expect(result).toMatchObject({ ok: false, quotaExhausted: true, requestsUsed: 1 });
  } finally {
    globalThis.fetch = original;
  }
});

test("Gemini turns off Discord actions and autonomous chat for now", () => {
  const limited = withProviderLimits(
    config({ discordActionsEnabled: true, autonomousChatEnabled: true }),
  );
  expect(limited.discordActionsEnabled).toBe(false);
  expect(limited.autonomousChatEnabled).toBe(false);

  const openai = withProviderLimits(
    testConfig({ discordActionsEnabled: true, autonomousChatEnabled: true }),
  );
  expect(openai.discordActionsEnabled).toBe(true);
  expect(openai.autonomousChatEnabled).toBe(true);
});

/** Serves a reply or error per model, in the order given, and records which models were called. */
function fakeModels(byModel: Record<string, () => Response | Promise<Response>>) {
  const called: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const model = /models\/([^:]+):/.exec(String(input))?.[1] ?? "";
    called.push(model);
    return byModel[model]!();
  };
  return { called, fetcher };
}

const failWith = (status: number) => () =>
  new Response(JSON.stringify({ error: { message: "nope" } }), { status });

const runModels = (fetcher: Fetcher, attemptTimeoutMs = 20_000) => {
  const session = createGeminiProvider(config({ aiModel: "a, b ,a,c" }), {
    fetch: fetcher,
    attemptTimeoutMs,
  }).start({ userText: "hi", imageUrls: [], format: "text" });
  return { session, step: session.step(new AbortController().signal) };
};

test("a retryable failure falls back to the next model and every attempt is counted", async () => {
  for (const status of [408, 429, 500, 503, 504]) {
    const { called, fetcher } = fakeModels({ a: failWith(status), b: () => reply("from b") });
    const { session, step } = runModels(fetcher);

    expect(await step).toMatchObject({ ok: true, text: "from b" });
    expect(called).toEqual(["a", "b"]);
    expect(session.calls).toBe(2);
  }
});

test("a 400, 401 or 403 stops without trying other models", async () => {
  for (const status of [400, 401, 403]) {
    const { called, fetcher } = fakeModels({ a: failWith(status), b: () => reply("no") });
    const { step } = runModels(fetcher);

    const result = await step;
    assert(!result.ok);
    expect(result.error).toContain(`Gemini error ${status}`);
    expect(result.quotaExhausted).toBeFalsy();
    expect(called).toEqual(["a"]);
  }
});

test("it is a quota error only when every model returned 429", async () => {
  const allLimited = fakeModels({ a: failWith(429), b: failWith(429), c: failWith(429) });
  expect(await runModels(allLimited.fetcher).step).toMatchObject({
    ok: false,
    quotaExhausted: true,
  });
  expect(allLimited.called).toEqual(["a", "b", "c"]);

  const mixed = fakeModels({ a: failWith(429), b: failWith(503), c: failWith(429) });
  expect(await runModels(mixed.fetcher).step).toMatchObject({ ok: false, quotaExhausted: false });
});

test("a model that hangs is abandoned after its time slice", async () => {
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))),
    );
  const called: string[] = [];
  const fetcher: Fetcher = (input, init) => {
    const model = /models\/([^:]+):/.exec(String(input))?.[1] ?? "";
    called.push(model);
    return model === "a" ? hang(init) : Promise.resolve(reply("from b"));
  };
  const { session, step } = runModels(fetcher, 30);

  expect(await step).toMatchObject({ ok: true, text: "from b" });
  expect(session.calls).toBe(2);
});

test("a network error falls back, but a caller abort stops the chain", async () => {
  const flaky = fakeModels({
    a: () => {
      throw new TypeError("fetch failed");
    },
    b: () => reply("from b"),
  });
  expect(await runModels(flaky.fetcher).step).toMatchObject({ ok: true, text: "from b" });

  const controller = new AbortController();
  const called: string[] = [];
  const fetcher: Fetcher = async (input) => {
    called.push(String(input));
    controller.abort();
    throw new DOMException("x", "AbortError");
  };
  const session = createGeminiProvider(config({ aiModel: "a,b" }), { fetch: fetcher }).start({
    userText: "hi",
    imageUrls: [],
    format: "text",
  });
  await session.step(controller.signal).catch(() => {});
  expect(called).toHaveLength(1);
  expect(session.calls).toBe(1);
});

test("the service reports every attempt as a request", async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = Object.assign(async () => (++n < 3 ? failWith(503)() : reply("finally")), {
    preconnect() {},
  }) as typeof fetch;
  try {
    const result = await createAiService(config({ aiModel: "a,b,c" })).generateReply([
      { author: "Alice", content: "hi" },
    ]);
    expect(result).toMatchObject({ ok: true, text: "finally", requestsUsed: 3 });
  } finally {
    globalThis.fetch = original;
  }
});

test("startup stops when the model list has no names", () => {
  throws(() => createGeminiProvider(config({ aiModel: " , " })), Error, "no model names");
});
