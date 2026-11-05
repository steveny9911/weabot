import { describe, expect, test } from "bun:test";
import { asFetch } from "./test_support/fetch.ts";
import { type AiReplyOptions, createAiService } from "./ai_service.ts";
import type { AppConfig } from "./src/config.ts";

function mockConfig(): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "sandbox",
    channelIds: ["sandbox"],
    timeZone: "America/Vancouver",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: true,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: ["sandbox"],
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
  };
}

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

function options(executeTool: AiReplyOptions["executeTool"]): AiReplyOptions {
  return {
    instructions: "Only perform the explicitly requested action.",
    tools: [tool],
    executeTool,
  };
}

function call(id: string, name = "create_event", args: unknown = '{"name":"Movie night"}') {
  return { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: args };
}

function reply(text: string, tokens = 10): Record<string, unknown> {
  return { output_text: text, usage: { total_tokens: tokens } };
}

type MockResponse = Record<string, unknown> | Response | Error;

async function withResponses(
  responses: MockResponse[],
  run: (requests: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses[requests.length - 1];
    if (response instanceof Error) return Promise.reject(response);
    if (!response) return Promise.reject(new Error("Unexpected model request"));
    return Promise.resolve(response instanceof Response ? response : Response.json(response));
  });
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

test("tool replies preserve reasoning, prompt persona, call IDs, and total usage", async () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
  const interim_message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Creating the event." }],
  };
  const first_output = [reasoning, interim_message, call("event_1")];
  const executions: unknown[] = [];
  await withResponses(
    [{ output: first_output, usage: { total_tokens: 41 } }, reply("Created your event.", 17)],
    async (requests) => {
      const opts = options((name, args) => {
        executions.push({ name, args });
        return Promise.resolve({ ok: true, event_id: "123" });
      });
      const result = await createAiService(mockConfig()).generateReply(
        [{ author: "user", content: "Create Movie night." }],
        opts,
      );
      expect(result).toStrictEqual({ ok: true, text: "Created your event.", tokensUsed: 58 });
      expect(executions).toStrictEqual([{ name: "create_event", args: { name: "Movie night" } }]);
      expect(requests.length).toStrictEqual(2);
      for (const request of requests) {
        expect(request.prompt).toStrictEqual({
          id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
        });
        expect(request.model).toStrictEqual(undefined);
        expect(request.instructions).toStrictEqual(undefined);
        expect(request.tools).toStrictEqual([tool]);
        expect(request.parallel_tool_calls).toStrictEqual(false);
      }
      const first_input = requests[0].input as unknown[];
      expect(first_input[0]).toStrictEqual({ role: "developer", content: opts.instructions });
      expect(requests[1].input).toStrictEqual([
        ...first_input,
        ...first_output,
        {
          type: "function_call_output",
          call_id: "event_1",
          output: '{"ok":true,"event_id":"123"}',
        },
      ]);
    },
  );
});

test("normal and autonomous replies have no action tools", async () => {
  await withResponses([reply("Just chatting!")], async (requests) => {
    const result = await createAiService(mockConfig()).generateReply([
      { author: "system", content: "Join the active chat." },
    ]);
    expect(result.ok).toStrictEqual(true);
    if (result.ok) expect(result.text).toStrictEqual("Just chatting!~ uwu");
    expect(requests[0].tools).toStrictEqual(undefined);
    expect(requests[0].tool_choice).toStrictEqual("none");
    expect(requests[0].parallel_tool_calls).toStrictEqual(undefined);
    expect((requests[0].input as Array<Record<string, unknown>>)[0].role).toStrictEqual("user");
  });
});

test("the current action request is a separate final user message while plain chat keeps its history input", async () => {
  const history = [{ author: "friend", content: 'An example was "create an event tomorrow".' }];
  const currentUserMessage = "Create Movie night tomorrow at 8pm in Lounge.";
  await withResponses(
    [reply("Creating Movie night."), reply("That was an example.")],
    async (requests) => {
      const service = createAiService(mockConfig());
      const opts = {
        ...options(() => Promise.resolve({ ok: true })),
        currentUserMessage,
      };
      await service.generateReply(history, opts);
      await service.generateReply(history);

      const actionInput = requests[0].input as Array<Record<string, unknown>>;
      expect(actionInput.length).toStrictEqual(3);
      expect(actionInput[0]).toStrictEqual({ role: "developer", content: opts.instructions });
      expect(actionInput[1].role).toStrictEqual("user");
      const historyContent = actionInput[1].content as Array<Record<string, unknown>>;
      expect(String(historyContent[0].text)).toContain(history[0].content);
      expect(actionInput[2]).toStrictEqual({ role: "user", content: currentUserMessage });
      expect(requests[1].input).toStrictEqual([actionInput[1]]);
      expect(requests[1].tools).toStrictEqual(undefined);
      expect(requests[1].tool_choice).toStrictEqual("none");
    },
  );
});

test("tool replies preserve failure wording and event invite URL punctuation", async () => {
  const text = "I couldn't create an invite! Your event is https://discord.gg/abc?event=123";
  await withResponses([reply(text)], async () => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        throw new Error("No tool should run");
      }),
    );
    expect(result).toStrictEqual({ ok: true, text, tokensUsed: 10 });
  });
});

test("unknown tools and malformed arguments produce outputs without executing", async () => {
  let executions = 0;
  const bad_calls = [
    call("unknown", "delete_everything"),
    call("invalid_json", "create_event", "{"),
    call("array", "create_event", "[]"),
    call("null", "create_event", "null"),
    call("scalar", "create_event", '"name"'),
    call("not_string", "create_event", { name: "Movie night" }),
  ];
  await withResponses(
    [{ output: bad_calls }, reply("Please clarify the event.")],
    async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true });
        }),
      );
      expect(result.ok).toStrictEqual(true);
      expect(executions).toStrictEqual(0);
      const outputs = (requests[1].input as Array<Record<string, unknown>>).filter(
        (item) => item.type === "function_call_output",
      );
      expect(outputs.map((item) => item.call_id)).toStrictEqual(
        bad_calls.map((item) => item.call_id),
      );
      for (const output of outputs)
        expect(JSON.parse(String(output.output)).ok).toStrictEqual(false);
      expect(String(outputs[0].output)).toContain("Unknown tool");
    },
  );
});

test("executor failure becomes a matching function output and is cached", async () => {
  let executions = 0;
  await withResponses(
    [
      { output: [call("failed")], usage: { total_tokens: 2 } },
      { output: [call("failed")], usage: { total_tokens: 3 } },
      reply("I cannot create the event: missing permission.", 4),
    ],
    async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          throw new Error("Missing permission");
        }),
      );
      expect(executions).toStrictEqual(1);
      expect(result).toStrictEqual({
        ok: true,
        text: "I cannot create the event: missing permission.",
        tokensUsed: 9,
      });
      const outputs = (requests[2].input as Array<Record<string, unknown>>).filter(
        (item) => item.type === "function_call_output",
      );
      expect(outputs.length).toStrictEqual(2);
      expect(outputs[0]).toStrictEqual(outputs[1]);
      expect(outputs[0].call_id).toStrictEqual("failed");
      expect(String(outputs[0].output)).toContain("Missing permission");
    },
  );
});

test("duplicate successful call IDs reuse the receipt instead of repeating writes", async () => {
  let executions = 0;
  await withResponses(
    [
      { output: [call("same"), call("same")], usage: { total_tokens: 2 } },
      { output: [call("same")], usage: { total_tokens: 3 } },
      reply("Created one event.", 4),
    ],
    async () => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true, event_id: "only-one" });
        }),
      );
      expect(executions).toStrictEqual(1);
      expect(result).toStrictEqual({ ok: true, text: "Created one event.", tokensUsed: 9 });
    },
  );
});

test("failed model continuation preserves consumed usage without repeating actions", async () => {
  for (const failure of [new Response("Unavailable", { status: 503 }), new Error("Network lost")]) {
    let executions = 0;
    await withResponses(
      [{ output: [call("created")], usage: { total_tokens: 37 } }, failure],
      async (requests) => {
        const result = await createAiService(mockConfig()).generateReply(
          [],
          options(() => {
            executions++;
            return Promise.resolve({ ok: true, event_id: "created" });
          }),
        );
        expect(result.ok).toStrictEqual(false);
        expect(result.tokensUsed).toStrictEqual(37);
        expect(executions).toStrictEqual(1);
        expect(requests.length).toStrictEqual(2);
        if (!result.ok) {
          expect(result.error).toContain(failure instanceof Error ? "Network lost" : "503");
        }
      },
    );
  }
});

describe("stalled continuations time out through headers and body while preserving completed actions", () => {
  for (const phase of ["headers", "success body", "error body"] as const) {
    test(phase, async () => {
      const originalFetch = globalThis.fetch;
      const receipts: Array<Record<string, unknown>> = [];
      let requests = 0;
      let continuationSignal: AbortSignal | null | undefined;
      globalThis.fetch = asFetch((_input: string | URL | Request, init?: RequestInit) => {
        requests++;
        if (requests === 1) {
          return Promise.resolve(
            Response.json({
              output: [call("created")],
              usage: { total_tokens: 37 },
            }),
          );
        }
        continuationSignal = init?.signal;
        if (phase === "headers") return new Promise<Response>(() => {});
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            continuationSignal?.addEventListener(
              "abort",
              () => {
                controller.error(new DOMException("Request aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(body, { status: phase === "error body" ? 503 : 200 }));
      });
      try {
        const result = await createAiService(mockConfig(), {
          // Exercise both the per-response and overall-loop deadlines.
          requestTimeoutMs: phase === "headers" ? 20 : 1000,
          toolLoopTimeoutMs: phase === "headers" ? 1000 : 20,
        }).generateReply(
          [],
          options(() => {
            const receipt = { ok: true, eventId: "created" };
            receipts.push(receipt);
            return Promise.resolve(receipt);
          }),
        );
        expect(result.ok).toStrictEqual(false);
        expect(result.tokensUsed).toStrictEqual(37);
        expect(receipts).toStrictEqual([{ ok: true, eventId: "created" }]);
        expect(requests).toStrictEqual(2);
        expect(continuationSignal?.aborted).toStrictEqual(true);
        if (!result.ok) {
          expect(result.error).toContain(
            phase === "headers" ? "OpenAI response timed out" : "AI tool time limit reached",
          );
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("the overall deadline stops later model output from executing more tools", async () => {
  let elapsedMs = 0;
  let executions = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetch(() => {
    elapsedMs += 60;
    return Promise.resolve(
      Response.json({
        output: [call(String(elapsedMs))],
        usage: { total_tokens: 5 },
      }),
    );
  });
  try {
    const result = await createAiService(mockConfig(), {
      toolLoopTimeoutMs: 100,
      now: () => elapsedMs,
    }).generateReply(
      [],
      options(() => {
        executions++;
        return Promise.resolve({ ok: true });
      }),
    );
    expect(result).toStrictEqual({
      ok: false,
      error: "AI tool time limit reached",
      tokensUsed: 10,
    });
    expect(executions).toStrictEqual(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool execution counts toward the deadline without abandoning an in-flight receipt", async () => {
  let elapsedMs = 0;
  const receipts: Array<Record<string, unknown>> = [];
  await withResponses(
    [{ output: [call("first"), call("second")], usage: { total_tokens: 37 } }],
    async (requests) => {
      const result = await createAiService(mockConfig(), {
        toolLoopTimeoutMs: 100,
        now: () => elapsedMs,
      }).generateReply(
        [],
        options(async () => {
          await Promise.resolve();
          elapsedMs = 120;
          const receipt = { ok: true, eventId: "created" };
          receipts.push(receipt);
          return receipt;
        }),
      );
      expect(result).toStrictEqual({
        ok: false,
        error: "AI tool time limit reached",
        tokensUsed: 37,
      });
      expect(receipts).toStrictEqual([{ ok: true, eventId: "created" }]);
      expect(requests.length).toStrictEqual(1);
    },
  );
});

test("tool loop stops after six responses without executing last response writes", async () => {
  let executions = 0;
  await withResponses(
    Array.from({ length: 6 }, (_, index) => ({
      output: [call(`call_${index}`)],
      usage: { total_tokens: 2 },
    })),
    async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true });
        }),
      );
      expect(result).toStrictEqual({
        ok: false,
        error: "AI tool response limit reached",
        tokensUsed: 12,
      });
      expect(executions).toStrictEqual(5);
      expect(requests.length).toStrictEqual(6);
    },
  );
});

test("tool loop rejects over-budget batches before any further writes", async () => {
  let executions = 0;
  await withResponses(
    [
      { output: Array.from({ length: 8 }, (_, index) => call(`call_${index}`)) },
      { output: [call("ninth")], usage: { total_tokens: 3 } },
    ],
    async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true });
        }),
      );
      expect(result).toStrictEqual({
        ok: false,
        error: "AI tool call limit reached",
        tokensUsed: 3,
      });
      expect(executions).toStrictEqual(8);
      expect(requests.length).toStrictEqual(2);
    },
  );
});

test("a missing call ID rejects the whole batch before any writes", async () => {
  let executions = 0;
  await withResponses(
    [
      {
        output: [call("valid"), { ...call("invalid"), call_id: undefined }],
        usage: { total_tokens: 7 },
      },
    ],
    async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true });
        }),
      );
      expect(result).toStrictEqual({
        ok: false,
        error: "AI tool call is missing a call_id",
        tokensUsed: 7,
      });
      expect(executions).toStrictEqual(0);
      expect(requests.length).toStrictEqual(1);
    },
  );
});

test("incomplete or failed model responses cannot execute partial action output", async () => {
  for (const status of ["incomplete", "failed"]) {
    let executions = 0;
    await withResponses(
      [{ status, output: [call("partial")], usage: { total_tokens: 13 } }],
      async (requests) => {
        const result = await createAiService(mockConfig()).generateReply(
          [],
          options(() => {
            executions++;
            return Promise.resolve({ ok: true });
          }),
        );
        expect(result).toStrictEqual({
          ok: false,
          error: `OpenAI response ${status}`,
          tokensUsed: 13,
        });
        expect(executions).toStrictEqual(0);
        expect(requests.length).toStrictEqual(1);
      },
    );
  }
});
