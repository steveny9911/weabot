import { assertEquals, assertStringIncludes } from "@std/assert";
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
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses[requests.length - 1];
    if (response instanceof Error) return Promise.reject(response);
    if (!response) return Promise.reject(new Error("Unexpected model request"));
    return Promise.resolve(response instanceof Response ? response : Response.json(response));
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("tool replies preserve reasoning, prompt persona, call IDs, and total usage", async () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
  const interim_message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Creating the event." }],
  };
  const first_output = [reasoning, interim_message, call("event_1")];
  const executions: unknown[] = [];
  await withResponses([
    { output: first_output, usage: { total_tokens: 41 } },
    reply("Created your event.", 17),
  ], async (requests) => {
    const opts = options((name, args) => {
      executions.push({ name, args });
      return Promise.resolve({ ok: true, event_id: "123" });
    });
    const result = await createAiService(mockConfig()).generateReply(
      [{ author: "user", content: "Create Movie night." }],
      opts,
    );
    assertEquals(result, { ok: true, text: "Created your event.", tokensUsed: 58 });
    assertEquals(executions, [{ name: "create_event", args: { name: "Movie night" } }]);
    assertEquals(requests.length, 2);
    for (const request of requests) {
      assertEquals(request.prompt, { id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b" });
      assertEquals(request.model, undefined);
      assertEquals(request.instructions, undefined);
      assertEquals(request.tools, [tool]);
      assertEquals(request.parallel_tool_calls, false);
    }
    const first_input = requests[0].input as unknown[];
    assertEquals(first_input[0], { role: "developer", content: opts.instructions });
    assertEquals(requests[1].input, [
      ...first_input,
      ...first_output,
      { type: "function_call_output", call_id: "event_1", output: '{"ok":true,"event_id":"123"}' },
    ]);
  });
});

Deno.test("normal and autonomous replies have no action tools", async () => {
  await withResponses([reply("Just chatting!")], async (requests) => {
    const result = await createAiService(mockConfig()).generateReply([
      { author: "system", content: "Join the active chat." },
    ]);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.text, "Just chatting!~ uwu");
    assertEquals(requests[0].tools, undefined);
    assertEquals(requests[0].tool_choice, "none");
    assertEquals(requests[0].parallel_tool_calls, undefined);
    assertEquals((requests[0].input as Array<Record<string, unknown>>)[0].role, "user");
  });
});

Deno.test("the current action request is a separate final user message while plain chat keeps its history input", async () => {
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
      assertEquals(actionInput.length, 3);
      assertEquals(actionInput[0], { role: "developer", content: opts.instructions });
      assertEquals(actionInput[1].role, "user");
      const historyContent = actionInput[1].content as Array<Record<string, unknown>>;
      assertStringIncludes(String(historyContent[0].text), history[0].content);
      assertEquals(actionInput[2], { role: "user", content: currentUserMessage });
      assertEquals(requests[1].input, [actionInput[1]]);
      assertEquals(requests[1].tools, undefined);
      assertEquals(requests[1].tool_choice, "none");
    },
  );
});

Deno.test("tool replies preserve failure wording and event invite URL punctuation", async () => {
  const text = "I couldn't create an invite! Your event is https://discord.gg/abc?event=123";
  await withResponses([reply(text)], async () => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        throw new Error("No tool should run");
      }),
    );
    assertEquals(result, { ok: true, text, tokensUsed: 10 });
  });
});

Deno.test("unknown tools and malformed arguments produce outputs without executing", async () => {
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
      assertEquals(result.ok, true);
      assertEquals(executions, 0);
      const outputs = (requests[1].input as Array<Record<string, unknown>>)
        .filter((item) => item.type === "function_call_output");
      assertEquals(outputs.map((item) => item.call_id), bad_calls.map((item) => item.call_id));
      for (const output of outputs) assertEquals(JSON.parse(String(output.output)).ok, false);
      assertStringIncludes(String(outputs[0].output), "Unknown tool");
    },
  );
});

Deno.test("executor failure becomes a matching function output and is cached", async () => {
  let executions = 0;
  await withResponses([
    { output: [call("failed")], usage: { total_tokens: 2 } },
    { output: [call("failed")], usage: { total_tokens: 3 } },
    reply("I cannot create the event: missing permission.", 4),
  ], async (requests) => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        executions++;
        throw new Error("Missing permission");
      }),
    );
    assertEquals(executions, 1);
    assertEquals(result, {
      ok: true,
      text: "I cannot create the event: missing permission.",
      tokensUsed: 9,
    });
    const outputs = (requests[2].input as Array<Record<string, unknown>>)
      .filter((item) => item.type === "function_call_output");
    assertEquals(outputs.length, 2);
    assertEquals(outputs[0], outputs[1]);
    assertEquals(outputs[0].call_id, "failed");
    assertStringIncludes(String(outputs[0].output), "Missing permission");
  });
});

Deno.test("duplicate successful call IDs reuse the receipt instead of repeating writes", async () => {
  let executions = 0;
  await withResponses([
    { output: [call("same"), call("same")], usage: { total_tokens: 2 } },
    { output: [call("same")], usage: { total_tokens: 3 } },
    reply("Created one event.", 4),
  ], async () => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        executions++;
        return Promise.resolve({ ok: true, event_id: "only-one" });
      }),
    );
    assertEquals(executions, 1);
    assertEquals(result, { ok: true, text: "Created one event.", tokensUsed: 9 });
  });
});

Deno.test("failed model continuation preserves consumed usage without repeating actions", async () => {
  for (const failure of [new Response("Unavailable", { status: 503 }), new Error("Network lost")]) {
    let executions = 0;
    await withResponses([
      { output: [call("created")], usage: { total_tokens: 37 } },
      failure,
    ], async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true, event_id: "created" });
        }),
      );
      assertEquals(result.ok, false);
      assertEquals(result.tokensUsed, 37);
      assertEquals(executions, 1);
      assertEquals(requests.length, 2);
      if (!result.ok) {
        assertStringIncludes(result.error, failure instanceof Error ? "Network lost" : "503");
      }
    });
  }
});

Deno.test("tool loop stops after six responses without executing last response writes", async () => {
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
      assertEquals(result, { ok: false, error: "AI tool response limit reached", tokensUsed: 12 });
      assertEquals(executions, 5);
      assertEquals(requests.length, 6);
    },
  );
});

Deno.test("tool loop rejects over-budget batches before any further writes", async () => {
  let executions = 0;
  await withResponses([
    { output: Array.from({ length: 8 }, (_, index) => call(`call_${index}`)) },
    { output: [call("ninth")], usage: { total_tokens: 3 } },
  ], async (requests) => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        executions++;
        return Promise.resolve({ ok: true });
      }),
    );
    assertEquals(result, { ok: false, error: "AI tool call limit reached", tokensUsed: 3 });
    assertEquals(executions, 8);
    assertEquals(requests.length, 2);
  });
});

Deno.test("a missing call ID rejects the whole batch before any writes", async () => {
  let executions = 0;
  await withResponses([
    {
      output: [call("valid"), { ...call("invalid"), call_id: undefined }],
      usage: { total_tokens: 7 },
    },
  ], async (requests) => {
    const result = await createAiService(mockConfig()).generateReply(
      [],
      options(() => {
        executions++;
        return Promise.resolve({ ok: true });
      }),
    );
    assertEquals(result, { ok: false, error: "AI tool call is missing a call_id", tokensUsed: 7 });
    assertEquals(executions, 0);
    assertEquals(requests.length, 1);
  });
});

Deno.test("incomplete or failed model responses cannot execute partial action output", async () => {
  for (const status of ["incomplete", "failed"]) {
    let executions = 0;
    await withResponses([
      { status, output: [call("partial")], usage: { total_tokens: 13 } },
    ], async (requests) => {
      const result = await createAiService(mockConfig()).generateReply(
        [],
        options(() => {
          executions++;
          return Promise.resolve({ ok: true });
        }),
      );
      assertEquals(result, { ok: false, error: `OpenAI response ${status}`, tokensUsed: 13 });
      assertEquals(executions, 0);
      assertEquals(requests.length, 1);
    });
  }
});
