import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { testConfig } from "../../tests/support/config.ts";
import { createRequestHandler } from "../app/server.ts";
import type { PollRecord } from "../types/storage.ts";
import {
  createDiscordClient,
  type DiscordClient,
  type PollAnswerVoters,
} from "../discord/client.ts";
import { createStorageService, type StorageService } from "../services/storage.ts";
import { openDatabase } from "../db/database.ts";
import { collectExpiredPolls } from "./collect_polls.ts";

const moods = ["umazing", "ok", "glue"];
const poll: PollRecord = {
  messageId: "poll",
  channelId: "channel",
  date: "2026-09-01",
  createdAt: 0,
  expiresAt: 1,
  collected: false,
};

/** Runs one collection and returns how many polls were collected and how many failed. */
async function collect(discord: DiscordClient, storage: StorageService) {
  const { collected, failed } = await collectExpiredPolls(discord, storage);
  return { collected: collected.length, failed: failed.length };
}

function mockFetch(handler: (url: URL) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = asFetch((input: string | URL | Request) =>
    Promise.resolve(handler(new URL(input instanceof Request ? input.url : input))),
  );
  return () => {
    globalThis.fetch = original;
  };
}

function message(zero = false): Record<string, unknown> {
  return {
    poll: {
      answers: moods.map((text, index) => ({ answer_id: index + 1, poll_media: { text } })),
      results: {
        is_finalized: true,
        answer_counts: zero ? [] : moods.map((_, index) => ({ id: index + 1, count: 1 })),
      },
    },
  };
}

function success(url: URL, zero = false): Response {
  if (url.pathname.includes("/messages/")) return Response.json(message(zero));
  const answer = Number(url.pathname.split("/").at(-1));
  return Response.json({
    users: zero ? [] : [{ id: String(100 + answer), username: `user-${answer}` }],
  });
}

async function assertThreeVotes(storage: StorageService) {
  const votes = await storage.getVotesForDate(poll.channelId, poll.date);
  expect(votes.map(({ userId, mood }) => ({ userId, mood }))).toStrictEqual([
    { userId: "101", mood: "umazing" },
    { userId: "102", mood: "ok" },
    { userId: "103", mood: "glue" },
  ]);
  expect((await storage.getStats(poll.channelId, poll.date, poll.date))[0].total).toStrictEqual(3);
  for (const vote of votes) {
    expect(await storage.getUserHistory(poll.channelId, vote.userId)).toStrictEqual([vote]);
  }
  expect(await storage.getExpiredPolls()).toStrictEqual([]);
}

const retrievalFailures: [string, (url: URL) => Response | undefined][] = [
  [
    "message HTTP 403",
    (url) =>
      url.pathname.includes("/messages/") ? new Response("Forbidden", { status: 403 }) : undefined,
  ],
  [
    "first answer HTTP 403",
    (url) =>
      url.pathname.endsWith("/answers/1") ? new Response("Forbidden", { status: 403 }) : undefined,
  ],
  [
    "partial answers then HTTP 404",
    (url) =>
      url.pathname.endsWith("/answers/2") ? new Response("Not found", { status: 404 }) : undefined,
  ],
  [
    "malformed message",
    (url) => (url.pathname.includes("/messages/") ? Response.json({}) : undefined),
  ],
  [
    "malformed voter response",
    (url) => (url.pathname.endsWith("/answers/2") ? Response.json({}) : undefined),
  ],
  [
    "invalid JSON",
    (url) => (url.pathname.endsWith("/answers/3") ? new Response("not json") : undefined),
  ],
  [
    "incomplete finalized tally",
    (url) => (url.pathname.endsWith("/answers/3") ? Response.json({ users: [] }) : undefined),
  ],
  [
    "unfinished tally",
    (url) =>
      url.pathname.includes("/messages/")
        ? Response.json({
            poll: {
              ...(message().poll as object),
              results: { is_finalized: false, answer_counts: [] },
            },
          })
        : undefined,
  ],
];

for (const [name, failure] of retrievalFailures) {
  test(`collection: ${name} remains pending and successful retry preserves every vote`, async () => {
    using kv = openDatabase(":memory:");
    const storage = createStorageService(kv);
    await storage.savePendingPoll(poll);
    let failing = true;
    let requests = 0;
    const restore = mockFetch((url) => {
      requests++;
      return (failing ? failure(url) : undefined) ?? success(url);
    });
    try {
      const discord = createDiscordClient("token");
      expect(await collect(discord, storage)).toStrictEqual({ collected: 0, failed: 1 });
      expect(await storage.getExpiredPolls()).toStrictEqual([poll]);
      expect(await storage.getVotesForDate(poll.channelId, poll.date)).toStrictEqual([]);
      failing = false;
      expect(await collect(discord, storage)).toStrictEqual({ collected: 1, failed: 0 });
      await assertThreeVotes(storage);
      const afterSuccess = requests;
      expect(await collect(discord, storage)).toStrictEqual({ collected: 0, failed: 0 });
      expect(requests).toStrictEqual(afterSuccess);
    } finally {
      restore();
    }
  });
}

test(`collection: finalized zero-vote poll is marked collected`, async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  await storage.savePendingPoll(poll);
  const restore = mockFetch((url) => success(url, true));
  try {
    expect(await collect(createDiscordClient("token"), storage)).toStrictEqual({
      collected: 1,
      failed: 0,
    });
    expect(await storage.getExpiredPolls()).toStrictEqual([]);
    expect(await storage.getVotesForDate(poll.channelId, poll.date)).toStrictEqual([]);
    expect(await storage.getAllPendingPolls()).toStrictEqual([]);
    expect(kv.query("SELECT collected_at IS NOT NULL AS collected FROM polls").all()).toStrictEqual(
      [{ collected: 1 }],
    );
  } finally {
    restore();
  }
});

for (const stage of ["second vote", "collection marker"] as const) {
  test(`collection: failure persisting ${stage} retries without duplicate votes or history`, async () => {
    using kv = openDatabase(":memory:");
    const storage = createStorageService(kv);
    await storage.savePendingPoll(poll);
    let writes = 0;
    let failing = true;
    const wrapped: StorageService = {
      ...storage,
      recordVote(...args) {
        writes++;
        if (failing && stage === "second vote" && writes === 2) {
          throw new Error("Injected disk failure");
        }
        return storage.recordVote(...args);
      },
      markPollCollected(id) {
        if (failing && stage === "collection marker") throw new Error("Injected marker failure");
        return storage.markPollCollected(id);
      },
    };
    const restore = mockFetch(success);
    try {
      const discord = createDiscordClient("token");
      expect(await collect(discord, wrapped)).toStrictEqual({ collected: 0, failed: 1 });
      expect(await storage.getExpiredPolls()).toStrictEqual([poll]);
      expect((await storage.getVotesForDate(poll.channelId, poll.date)).length).toStrictEqual(
        stage === "second vote" ? 1 : 3,
      );
      failing = false;
      expect(await collect(discord, wrapped)).toStrictEqual({ collected: 1, failed: 0 });
      await assertThreeVotes(storage);
    } finally {
      restore();
    }
  });
}

test(`collection: one failed poll does not block another expired poll`, async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  await storage.savePendingPoll(poll);
  await storage.savePendingPoll({ ...poll, messageId: "poll-2", date: "2026-09-02" });
  const restore = mockFetch((url) =>
    url.pathname.endsWith("/messages/poll")
      ? new Response("Forbidden", { status: 403 })
      : success(url),
  );
  try {
    expect(await collect(createDiscordClient("token"), storage)).toStrictEqual({
      collected: 1,
      failed: 1,
    });
    expect(await storage.getExpiredPolls()).toStrictEqual([poll]);
    expect((await storage.getVotesForDate(poll.channelId, "2026-09-02")).length).toStrictEqual(3);
    expect(await storage.getVotesForDate(poll.channelId, poll.date)).toStrictEqual([]);
  } finally {
    restore();
  }
});

for (const name of [
  "empty answers",
  "partial answers",
  "unknown mood",
  "duplicate mood",
  "duplicate voter",
] as const) {
  test(`collection: ${name} from a client cannot be silently skipped`, async () => {
    using kv = openDatabase(":memory:");
    const storage = createStorageService(kv);
    await storage.savePendingPoll(poll);
    let answers: PollAnswerVoters[] = moods.map((text, i) => ({
      answerId: i + 1,
      answerText: text,
      voters: [{ userId: String(i + 1), userName: text }],
    }));
    if (name === "empty answers") answers = [];
    if (name === "partial answers") answers = answers.slice(0, 2);
    if (name === "unknown mood") answers[2].answerText = "mystery";
    if (name === "duplicate mood") answers[2].answerText = "ok";
    if (name === "duplicate voter") answers[2].voters = answers[0].voters;
    const discord = {
      ...createDiscordClient("token"),
      getPollVoters: () => Promise.resolve(answers),
    };
    expect(await collect(discord, storage)).toStrictEqual({ collected: 0, failed: 1 });
    expect(await storage.getExpiredPolls()).toStrictEqual([poll]);
    expect(await storage.getVotesForDate(poll.channelId, poll.date)).toStrictEqual([]);
  });
}

test("/trigger_collect reports collected votes, and a failure as 500 pending retry", async () => {
  using kv = openDatabase(":memory:");
  const storage = createStorageService(kv);
  await storage.savePendingPoll(poll);
  await storage.savePendingPoll({ ...poll, messageId: "poll-2", date: "2026-09-02" });
  const handler = createRequestHandler({
    config: testConfig({ adminHttpToken: "token" }),
    discord: createDiscordClient("token"),
    storage,
  });
  const restore = mockFetch((url) =>
    url.pathname.endsWith("/messages/poll")
      ? new Response("Forbidden", { status: 403 })
      : success(url),
  );
  try {
    const response = await handler(
      new Request("http://localhost/trigger_collect", {
        method: "POST",
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(response.status).toStrictEqual(500);
    const text = await response.text();
    expect(text).toContain("Collected 3 votes from 1 poll(s); 1 failed");
    expect(text).toContain("Poll poll (2026-09-01): failed; pending retry");
  } finally {
    restore();
  }
});
