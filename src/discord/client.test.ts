import { expect, spyOn, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { assert, rejects } from "../../tests/support/assert.ts";
import { createDiscordClient } from "./client.ts";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  });

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("addReaction encodes its route and sends an authorized bodyless PUT", async () => {
  let requests = 0;
  const fetchMock = mockFetch((url, init) => {
    requests++;
    expect(url).toStrictEqual(
      "https://discord.com/api/v10/channels/channel%2Fone/messages/message%3Ftwo/reactions/%E2%9D%A4%EF%B8%8F/@me",
    );
    expect(init?.method).toStrictEqual("PUT");
    expect((init?.headers as Record<string, string>).Authorization).toStrictEqual("Bot test-token");
    expect(init?.body).toStrictEqual(undefined);
    expect(init?.redirect).toStrictEqual("error");
    assert(init?.signal instanceof AbortSignal);
    expect(init.signal.aborted).toStrictEqual(false);
    return new Response(null, { status: 204 });
  });

  try {
    const response = await createDiscordClient("test-token").addReaction(
      "channel/one",
      "message?two",
      "❤️",
    );
    expect(response.status).toStrictEqual(204);
    expect(requests).toStrictEqual(1);
  } finally {
    fetchMock.restore();
  }
});

for (const [name, status, code] of [
  ["missing permissions", 403, 50013],
  ["unknown emoji", 404, 10014],
  ["rate limit", 429, 0],
  ["server error", 500, 0],
] as const) {
  test(`addReaction returns ${name} without retrying or sending fallback text`, async () => {
    let requests = 0;
    const expected = Response.json({ code }, { status });
    const fetchMock = mockFetch((_url, init) => {
      requests++;
      expect(init?.method).toStrictEqual("PUT");
      return expected;
    });

    try {
      const response = await createDiscordClient("token").addReaction("channel", "message", "😂");
      expect(response).toStrictEqual(expected);
      expect(response.status).toStrictEqual(status);
      expect(await response.json()).toStrictEqual({ code });
      expect(requests).toStrictEqual(1);
    } finally {
      fetchMock.restore();
    }
  });
}
test("getRecentMessages clamps limit and maps Discord message payloads", async () => {
  let requestedUrl = "";
  const fetchMock = mockFetch((url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify([
        {
          id: "msg-1",
          content: "hello",
          timestamp: "2026-06-11T20:00:00.000Z",
          author: {
            id: "user-1",
            username: "alice",
            global_name: "Alice",
            bot: false,
          },
          attachments: [
            {
              url: "https://cdn.example.com/a.png",
              content_type: "image/png",
            },
            {
              url: "https://cdn.example.com/not-image.txt",
              content_type: "text/plain",
            },
          ],
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  try {
    const discord = createDiscordClient("token");
    const messages = await discord.getRecentMessages("channel-1", 500);

    expect(requestedUrl).toContain("/channels/channel-1/messages?limit=100");
    expect(messages).toStrictEqual([
      {
        id: "msg-1",
        authorId: "user-1",
        authorName: "Alice",
        authorBot: false,
        content: "hello",
        timestamp: "2026-06-11T20:00:00.000Z",
        imageUrls: ["https://cdn.example.com/a.png"],
      },
    ]);
  } finally {
    fetchMock.restore();
  }
});

test("getRecentMessages returns an empty array for Discord errors", async () => {
  const fetchMock = mockFetch(() => new Response("nope", { status: 403 }));

  try {
    const discord = createDiscordClient("token");
    const messages = await discord.getRecentMessages("channel-1", 20);
    expect(messages).toStrictEqual([]);
  } finally {
    fetchMock.restore();
  }
});

const MOOD_ANSWERS = ["umazing", "ok", "glue"].map((text, index) => ({
  answer_id: index + 1,
  poll_media: { text },
}));

function pollMessage(counts: number[] = [0, 0, 0]): Record<string, unknown> {
  return {
    poll: {
      answers: MOOD_ANSWERS,
      results: {
        is_finalized: true,
        answer_counts: counts.map((count, index) => ({ id: index + 1, count })),
      },
    },
  };
}

function json(value: unknown): Response {
  return Response.json(value);
}

test("getPollVoters accepts finalized zero-vote answers and absent zero counts", async () => {
  const requests: string[] = [];
  const fetchMock = mockFetch((url, init) => {
    requests.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toStrictEqual("Bot test-token");
    return json(url.includes("/messages/") ? pollMessage([]) : { users: [] });
  });
  try {
    expect(await createDiscordClient("test-token").getPollVoters("channel", "poll")).toStrictEqual([
      { answerId: 1, answerText: "umazing", voters: [] },
      { answerId: 2, answerText: "ok", voters: [] },
      { answerId: 3, answerText: "glue", voters: [] },
    ]);
    expect(requests.length).toStrictEqual(4);
    expect(requests[1]).toContain("/answers/1?limit=100");
  } finally {
    fetchMock.restore();
  }
});

test("getPollVoters paginates every answer using exact snowflake cursors", async () => {
  const base = 90071992547409930n;
  const users = Array.from({ length: 205 }, (_, i) => ({
    id: (base + BigInt(i)).toString(),
    username: `user-${i}`,
    global_name: i === 0 ? "Display name" : null,
  }));
  const requests: string[] = [];
  const fetchMock = mockFetch((raw) => {
    const url = new URL(raw);
    requests.push(raw);
    if (url.pathname.includes("/messages/")) return json(pollMessage([205, 0, 0]));
    if (!url.pathname.endsWith("/1")) return json({ users: [] });
    const after = BigInt(url.searchParams.get("after") ?? "0");
    return json({ users: users.filter((user) => BigInt(user.id) > after).slice(0, 100) });
  });
  try {
    const result = await createDiscordClient("token").getPollVoters("channel", "poll");
    expect(result[0].voters.length).toStrictEqual(205);
    expect(result[0].voters[0].userName).toStrictEqual("Display name");
    expect(result[0].voters[204].userName).toStrictEqual("user-204");
    expect(requests[2]).toContain(`after=${base + 99n}`);
    expect(requests[3]).toContain(`after=${base + 199n}`);
    expect(requests.length).toStrictEqual(6);
  } finally {
    fetchMock.restore();
  }
});

for (const stage of ["message", "first answer", "later answer", "later page"] as const) {
  test(`getPollVoters rejects HTTP failure at ${stage} without returning partial data`, async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/messages/")) {
        return stage === "message"
          ? new Response("Forbidden", { status: 403 })
          : json(pollMessage(stage === "later page" ? [101, 0, 0] : [0, 0, 0]));
      }
      if (
        (stage === "first answer" && url.includes("/answers/1?")) ||
        (stage === "later answer" && url.includes("/answers/2?")) ||
        (stage === "later page" && url.includes("after="))
      )
        return new Response("Forbidden", { status: 403 });
      return json({
        users:
          stage === "later page"
            ? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }))
            : [],
      });
    });
    try {
      const error = await rejects(
        () => createDiscordClient("token").getPollVoters("channel", "poll"),
        Error,
        "poll poll in channel channel",
      );
      expect(String(error.cause)).toContain("HTTP 403");
    } finally {
      fetchMock.restore();
    }
  });
}

test("getPollVoters rejects non-advancing pagination instead of looping", async () => {
  const fetchMock = mockFetch((url) =>
    json(
      url.includes("/messages/")
        ? pollMessage([200, 0, 0])
        : {
            users: Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) })),
          },
    ),
  );
  try {
    await rejects(
      () => createDiscordClient("token").getPollVoters("channel", "poll"),
      Error,
      "repeated voter",
    );
  } finally {
    fetchMock.restore();
  }
});

test("single-message revalidation rejects wrong IDs and missing messages", async () => {
  const original = globalThis.fetch;
  try {
    const client = createDiscordClient("test-token");
    globalThis.fetch = asFetch(() =>
      Promise.resolve(
        Response.json({
          id: "wrong",
          author: { id: "human" },
          content: "Changed",
          timestamp: "2026-10-13T22:06:00Z",
        }),
      ),
    );
    expect(await client.getMessage!("channel", "target")).toStrictEqual(null);
    globalThis.fetch = asFetch(() =>
      Promise.resolve(Response.json({ code: 10008 }, { status: 404 })),
    );
    expect(await client.getMessage!("channel", "target")).toStrictEqual(null);
    globalThis.fetch = asFetch(() =>
      Promise.resolve(
        Response.json({
          id: "target",
          author: { id: "human" },
          content: "A joke",
          timestamp: "2026-10-13T22:06:00Z",
          reactions: [{ me: true }],
        }),
      ),
    );
    expect((await client.getMessage!("channel", "target"))?.hasOwnReaction).toStrictEqual(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("getBotUserId caches the ID, but not a failure", async () => {
  let status = 401;
  let requests = 0;
  const fetchMock = mockFetch(() => {
    requests++;
    return Response.json({ id: "bot-1" }, { status });
  });
  try {
    const client = createDiscordClient("token");
    expect(await client.getBotUserId()).toStrictEqual(undefined);
    status = 200;
    expect(await client.getBotUserId()).toStrictEqual("bot-1");
    expect(await client.getBotUserId()).toStrictEqual("bot-1");
    expect(requests).toStrictEqual(2);
  } finally {
    fetchMock.restore();
  }
});

test("sendMessage posts text, can suppress mentions, and reports a refusal", async () => {
  const bodies: unknown[] = [];
  let status = 200;
  const fetchMock = mockFetch((url, init) => {
    expect(url).toStrictEqual("https://discord.com/api/v10/channels/chan/messages");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("Missing Access", { status });
  });
  try {
    const client = createDiscordClient("token");
    expect(await client.sendMessage("chan", "hi", true)).toStrictEqual({ ok: true });
    status = 403;
    expect(await client.sendMessage("chan", "hello")).toStrictEqual({
      ok: false,
      error: "Discord post error 403: Missing Access",
    });
    expect(bodies).toStrictEqual([
      { content: "hi", allowed_mentions: { parse: [] } },
      { content: "hello" },
    ]);
  } finally {
    fetchMock.restore();
  }
});

test("timeoutMember patches the member with a timeout end and an audit reason", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = mockFetch((url, init) => {
    requests.push({ url, init });
    return new Response("{}", { status: 200 });
  });
  try {
    const before = Date.now();
    const result = await createDiscordClient("test-token").timeoutMember("g", "u", 60, "Because");
    expect(result).toStrictEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url).toStrictEqual("https://discord.com/api/v10/guilds/g/members/u");
    expect(init?.method).toStrictEqual("PATCH");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toStrictEqual("Bot test-token");
    expect(headers["X-Audit-Log-Reason"]).toStrictEqual("Because");
    const until = Date.parse(JSON.parse(init?.body as string).communication_disabled_until);
    expect(until).toBeGreaterThanOrEqual(before + 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
  } finally {
    fetchMock.restore();
  }
});

test("timeoutMember reports a Discord refusal", async () => {
  const fetchMock = mockFetch(() => new Response("Missing Permissions", { status: 403 }));
  try {
    expect(await createDiscordClient("token").timeoutMember("g", "u", 60, "Because")).toStrictEqual(
      { ok: false, error: "Discord timeout error 403: Missing Permissions" },
    );
  } finally {
    fetchMock.restore();
  }
});

test("sendMessage and timeoutMember report a network error once, without retrying the write", async () => {
  let requests = 0;
  const fetchMock = mockFetch(() => {
    requests++;
    throw new Error("network down");
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const client = createDiscordClient("token");
    expect(await client.sendMessage("chan", "hi")).toStrictEqual({
      ok: false,
      error: "Error: network down",
    });
    expect(await client.timeoutMember("g", "u", 60, "Because")).toStrictEqual({
      ok: false,
      error: "Error: network down",
    });
    expect(requests).toStrictEqual(2);
  } finally {
    logged.mockRestore();
    fetchMock.restore();
  }
});
