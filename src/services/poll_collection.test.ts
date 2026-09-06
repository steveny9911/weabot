import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AiService } from "../../ai_service.ts";
import type { AppConfig } from "../config.ts";
import { registerCronJobs } from "../scheduler.ts";
import { createRequestHandler } from "../server.ts";
import type { PollRecord } from "../types/storage.ts";
import { createDiscordClient, type DiscordClient, type PollAnswerVoters } from "./discord.ts";
import type { RateLimitService } from "./rate_limit.ts";
import { createStorageService, type StorageService } from "./storage.ts";

const config = {
  channelId: "channel",
  channelIds: ["channel"],
  adminHttpToken: "test-admin-token",
} as AppConfig & { adminHttpToken: string };
const formatter = new Intl.DateTimeFormat("en-US");
const moods = ["umazing", "ok", "glue"];
const poll: PollRecord = {
  messageId: "poll",
  channelId: "channel",
  date: "2026-09-01",
  createdAt: 0,
  expiresAt: 1,
  collected: false,
};

type Mode = "HTTP" | "scheduled";
function collectionRunner(mode: Mode, discord: DiscordClient, storage: StorageService) {
  if (mode === "HTTP") {
    const handler = createRequestHandler(config, discord, storage, formatter);
    return () =>
      handler(
        new Request("http://localhost/trigger_collect", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.adminHttpToken}` },
        }),
      );
  }

  // Exercise the callback actually registered by the scheduler, without real cron jobs.
  const descriptor = Object.getOwnPropertyDescriptor(Deno, "cron");
  const jobs = new Map<string, () => Promise<void>>();
  Object.defineProperty(Deno, "cron", {
    configurable: true,
    value: (name: string, _schedule: string, task: () => Promise<void>) => {
      jobs.set(name, task);
      return Promise.resolve();
    },
  });
  try {
    registerCronJobs(config, discord, storage, formatter, {} as AiService, {} as RateLimitService);
  } finally {
    if (descriptor) Object.defineProperty(Deno, "cron", descriptor);
    else Reflect.deleteProperty(Deno, "cron");
  }
  const run = jobs.get("Poll Result Collection");
  if (!run) throw new Error("Poll collection cron was not registered");
  return async () => {
    await run();
    return undefined;
  };
}

function mockFetch(handler: (url: URL) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(handler(
      new URL(
        input instanceof Request ? input.url : input,
      ),
    ))) as typeof fetch;
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

async function assertCollectionResponse(response: Response | undefined, status: number) {
  if (response) {
    assertEquals(response.status, status);
    assertStringIncludes(await response.text(), status === 500 ? "pending retry" : "Collected");
  }
}

async function assertThreeVotes(storage: StorageService) {
  const votes = await storage.getVotesForDate(poll.channelId, poll.date);
  assertEquals(votes.map(({ odUserId, mood }) => ({ odUserId, mood })), [
    { odUserId: "101", mood: "umazing" },
    { odUserId: "102", mood: "ok" },
    { odUserId: "103", mood: "glue" },
  ]);
  assertEquals((await storage.getStats(poll.channelId, poll.date, poll.date))[0].total, 3);
  for (const vote of votes) {
    assertEquals(await storage.getUserHistory(poll.channelId, vote.odUserId), [vote]);
  }
  assertEquals(await storage.getExpiredPolls(), []);
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
    (url) => url.pathname.includes("/messages/") ? Response.json({}) : undefined,
  ],
  [
    "malformed voter response",
    (url) => url.pathname.endsWith("/answers/2") ? Response.json({}) : undefined,
  ],
  [
    "invalid JSON",
    (url) => url.pathname.endsWith("/answers/3") ? new Response("not json") : undefined,
  ],
  [
    "incomplete finalized tally",
    (url) => url.pathname.endsWith("/answers/3") ? Response.json({ users: [] }) : undefined,
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

for (const mode of ["HTTP", "scheduled"] as const) {
  for (const [name, failure] of retrievalFailures) {
    Deno.test(`${mode} collection: ${name} remains pending and successful retry preserves every vote`, async () => {
      using kv = await Deno.openKv(":memory:");
      const storage = createStorageService(kv);
      await storage.savePendingPoll(poll);
      let failing = true;
      let requests = 0;
      const restore = mockFetch((url) => {
        requests++;
        return (failing ? failure(url) : undefined) ?? success(url);
      });
      try {
        const run = collectionRunner(mode, createDiscordClient("token"), storage);
        await assertCollectionResponse(await run(), 500);
        assertEquals(await storage.getExpiredPolls(), [poll]);
        assertEquals(await storage.getVotesForDate(poll.channelId, poll.date), []);
        failing = false;
        await assertCollectionResponse(await run(), 200);
        await assertThreeVotes(storage);
        const afterSuccess = requests;
        const repeated = await run();
        if (repeated) assertEquals(repeated.status, 200);
        assertEquals(requests, afterSuccess, "Collected polls must not be re-fetched");
      } finally {
        restore();
      }
    });
  }

  Deno.test(`${mode} collection: finalized zero-vote poll is marked collected`, async () => {
    using kv = await Deno.openKv(":memory:");
    const storage = createStorageService(kv);
    await storage.savePendingPoll(poll);
    const restore = mockFetch((url) => success(url, true));
    try {
      await assertCollectionResponse(
        await collectionRunner(mode, createDiscordClient("token"), storage)(),
        200,
      );
      assertEquals(await storage.getExpiredPolls(), []);
      assertEquals(await storage.getVotesForDate(poll.channelId, poll.date), []);
      assertEquals(
        (await kv.get<PollRecord>(["pending_polls", poll.messageId])).value?.collected,
        true,
      );
    } finally {
      restore();
    }
  });

  for (const stage of ["second vote", "collection marker"] as const) {
    Deno.test(`${mode} collection: failure persisting ${stage} retries without duplicate votes or history`, async () => {
      using kv = await Deno.openKv(":memory:");
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
        const run = collectionRunner(mode, createDiscordClient("token"), wrapped);
        await assertCollectionResponse(await run(), 500);
        assertEquals(await storage.getExpiredPolls(), [poll]);
        assertEquals(
          (await storage.getVotesForDate(poll.channelId, poll.date)).length,
          stage === "second vote" ? 1 : 3,
        );
        failing = false;
        await assertCollectionResponse(await run(), 200);
        await assertThreeVotes(storage);
      } finally {
        restore();
      }
    });
  }

  Deno.test(`${mode} collection: one failed poll does not block another expired poll`, async () => {
    using kv = await Deno.openKv(":memory:");
    const storage = createStorageService(kv);
    await storage.savePendingPoll(poll);
    await storage.savePendingPoll({ ...poll, messageId: "poll-2", date: "2026-09-02" });
    const restore = mockFetch((url) =>
      url.pathname.endsWith("/messages/poll")
        ? new Response("Forbidden", { status: 403 })
        : success(url)
    );
    try {
      const result = await collectionRunner(mode, createDiscordClient("token"), storage)();
      await assertCollectionResponse(result, 500);
      assertEquals(await storage.getExpiredPolls(), [poll]);
      assertEquals((await storage.getVotesForDate(poll.channelId, "2026-09-02")).length, 3);
      assertEquals(await storage.getVotesForDate(poll.channelId, poll.date), []);
    } finally {
      restore();
    }
  });

  for (
    const name of [
      "empty answers",
      "partial answers",
      "unknown mood",
      "duplicate mood",
      "duplicate voter",
    ] as const
  ) {
    Deno.test(`${mode} collection: ${name} from a client cannot be silently skipped`, async () => {
      using kv = await Deno.openKv(":memory:");
      const storage = createStorageService(kv);
      await storage.savePendingPoll(poll);
      let answers: PollAnswerVoters[] = moods.map((text, i) => ({
        answerId: i + 1,
        answerText: text,
        voters: [{ odUserId: String(i + 1), odUserName: text }],
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
      await assertCollectionResponse(await collectionRunner(mode, discord, storage)(), 500);
      assertEquals(await storage.getExpiredPolls(), [poll]);
      assertEquals(await storage.getVotesForDate(poll.channelId, poll.date), []);
    });
  }
}
