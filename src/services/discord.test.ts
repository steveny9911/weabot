import { expect, test } from "bun:test";
import { asFetch } from "../../test_support/fetch.ts";
import { assert, rejects } from "../../test_support/assert.ts";
import { createDiscordClient } from "./discord.ts";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  restore: () => void;
} {
  const original_fetch = globalThis.fetch;

  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  });

  return {
    restore: () => {
      globalThis.fetch = original_fetch;
    },
  };
}

test("addReaction encodes its route and sends an authorized bodyless PUT", async () => {
  let requests = 0;
  const fetch_mock = mockFetch((url, init) => {
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
    fetch_mock.restore();
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
    const fetch_mock = mockFetch((_url, init) => {
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
      fetch_mock.restore();
    }
  });
}

test("addReaction propagates network failure without retrying", async () => {
  let requests = 0;
  const fetch_mock = mockFetch(() => {
    requests++;
    throw new TypeError("connection failed");
  });

  try {
    await rejects(
      () => createDiscordClient("token").addReaction("channel", "message", "😂"),
      TypeError,
      "connection failed",
    );
    expect(requests).toStrictEqual(1);
  } finally {
    fetch_mock.restore();
  }
});

test("getRecentMessages clamps limit and maps Discord message payloads", async () => {
  let requested_url = "";
  const fetch_mock = mockFetch((url) => {
    requested_url = url;
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

    expect(requested_url).toContain("/channels/channel-1/messages?limit=100");
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
    fetch_mock.restore();
  }
});

test("getRecentMessages returns an empty array for Discord errors", async () => {
  const fetch_mock = mockFetch(() => new Response("nope", { status: 403 }));

  try {
    const discord = createDiscordClient("token");
    const messages = await discord.getRecentMessages("channel-1", 20);
    expect(messages).toStrictEqual([]);
  } finally {
    fetch_mock.restore();
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
  const fetch_mock = mockFetch((url, init) => {
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
    fetch_mock.restore();
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
  const fetch_mock = mockFetch((raw) => {
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
    fetch_mock.restore();
  }
});

test("getPollVoters checks the empty page after exactly 100 voters", async () => {
  let answerRequests = 0;
  const fetch_mock = mockFetch((url) => {
    if (url.includes("/messages/")) return json(pollMessage([100, 0, 0]));
    if (!url.includes("/answers/1?")) return json({ users: [] });
    answerRequests++;
    return json({
      users:
        answerRequests === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) })) : [],
    });
  });
  try {
    const answers = await createDiscordClient("token").getPollVoters("channel", "poll");
    expect(answers[0].voters.length).toStrictEqual(100);
    expect(answers[0].voters[0].odUserName).toStrictEqual("1");
    expect(answerRequests).toStrictEqual(2);
  } finally {
    fetch_mock.restore();
  }
});

const malformedMessages: [string, unknown][] = [
  ["null message", null],
  ["missing poll", {}],
  ["empty answers", { poll: { answers: [] } }],
  ["non-array answers", { poll: { answers: {} } }],
  ["invalid answer id", { poll: { answers: [{ answer_id: "1", poll_media: { text: "ok" } }] } }],
  ["duplicate answer", { poll: { answers: [MOOD_ANSWERS[0], MOOD_ANSWERS[0]] } }],
  ["invalid answer text", { poll: { answers: [{ answer_id: 1, poll_media: { text: 4 } }] } }],
  ["missing tally", { poll: { answers: MOOD_ANSWERS } }],
  [
    "unfinalized tally",
    {
      poll: { answers: MOOD_ANSWERS, results: { is_finalized: false, answer_counts: [] } },
    },
  ],
  ["missing counts", { poll: { answers: MOOD_ANSWERS, results: { is_finalized: true } } }],
  ["negative count", pollMessage([-1, 0, 0])],
  ["fractional count", pollMessage([1.5, 0, 0])],
  [
    "unknown answer count",
    {
      poll: {
        answers: MOOD_ANSWERS,
        results: { is_finalized: true, answer_counts: [{ id: 4, count: 1 }] },
      },
    },
  ],
  [
    "duplicate answer counts",
    {
      poll: {
        answers: MOOD_ANSWERS,
        results: {
          is_finalized: true,
          answer_counts: [
            { id: 1, count: 0 },
            { id: 1, count: 0 },
          ],
        },
      },
    },
  ],
];

for (const [name, message] of malformedMessages) {
  test(`getPollVoters rejects ${name}`, async () => {
    const fetch_mock = mockFetch(() => json(message));
    try {
      await rejects(
        () => createDiscordClient("token").getPollVoters("channel", "poll"),
        Error,
        "poll poll in channel channel",
      );
    } finally {
      fetch_mock.restore();
    }
  });
}

const malformedVoters: [string, unknown][] = [
  ["missing users", {}],
  ["null users", { users: null }],
  ["object users", { users: {} }],
  ["null user", { users: [null] }],
  ["missing user id", { users: [{ username: "Alice" }] }],
  ["non-snowflake id", { users: [{ id: "abc" }] }],
  ["zero id", { users: [{ id: "0" }] }],
  ["invalid username", { users: [{ id: "1", username: {} }] }],
  ["duplicate user", { users: [{ id: "1" }, { id: "1" }] }],
  ["too few users for finalized tally", { users: [] }],
  ["too many users for finalized tally", { users: [{ id: "1" }, { id: "2" }] }],
];
for (const [name, voters] of malformedVoters) {
  test(`getPollVoters rejects ${name}`, async () => {
    const fetch_mock = mockFetch((url) =>
      json(url.includes("/messages/") ? pollMessage([1, 0, 0]) : voters),
    );
    try {
      await rejects(
        () => createDiscordClient("token").getPollVoters("channel", "poll"),
        Error,
        "answer 1",
      );
    } finally {
      fetch_mock.restore();
    }
  });
}

for (const stage of ["message", "first answer", "later answer", "later page"] as const) {
  test(`getPollVoters rejects HTTP failure at ${stage} without returning partial data`, async () => {
    const fetch_mock = mockFetch((url) => {
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
      fetch_mock.restore();
    }
  });
}

test("getPollVoters rejects non-advancing pagination instead of looping", async () => {
  const fetch_mock = mockFetch((url) =>
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
    fetch_mock.restore();
  }
});

for (const stage of ["message", "voters"]) {
  test(`getPollVoters includes poll context for invalid JSON in ${stage}`, async () => {
    const fetch_mock = mockFetch((url) =>
      stage === "message" || !url.includes("/messages/")
        ? new Response("invalid json")
        : json(pollMessage()),
    );
    try {
      await rejects(
        () => createDiscordClient("token").getPollVoters("channel", "poll"),
        Error,
        "poll poll in channel channel",
      );
    } finally {
      fetch_mock.restore();
    }
  });
}

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
