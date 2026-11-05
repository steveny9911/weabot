import { expect, test } from "bun:test";
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
    expect(result[0].voters[0].odUserName).toStrictEqual("Display name");
    expect(result[0].voters[204].odUserName).toStrictEqual("user-204");
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
