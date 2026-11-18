import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { captureLogs } from "../../tests/support/logs.ts";
import { openDatabase } from "../db/database.ts";
import type { DiscordClient, MessagePayload } from "../discord/client.ts";
import { createStorageService, type StorageService } from "../services/storage.ts";
import type { JobDeps } from "./channel_posts.ts";
import { postMoodPolls } from "./mood_poll.ts";
import { postStats } from "./stats.ts";
import { postTestAlert, runWellnessCheck } from "./wellness.ts";

const NOW = new Date("2026-11-05T05:00:00Z");
let captured: ReturnType<typeof captureLogs>;
let logs: string[];

beforeEach(() => {
  setSystemTime(NOW);
  captured = captureLogs();
  logs = captured.lines;
});
afterEach(() => {
  captured.restore();
  setSystemTime();
});

/** Channel "bad" answers 403 with an error body; every other channel gets message IDs m1, m2, … */
function fixture(
  storage: StorageService = createStorageService(openDatabase(":memory:")),
  overrides: ConfigOverrides = {},
) {
  const posts: { channelId: string; payload: MessagePayload }[] = [];
  const discord = {
    postMessage(channelId: string, payload: MessagePayload) {
      posts.push({ channelId, payload });
      return Promise.resolve(
        channelId === "bad"
          ? new Response("Missing Access", { status: 403 })
          : Response.json({ id: `m${posts.length}` }),
      );
    },
  } as unknown as DiscordClient;
  const channelIds = ["good", "bad"];
  const config = testConfig(
    {
      moodPoll: { channelIds },
      wellness: { channelIds, glueAlertThreshold: 2 },
      weeklyStats: { channelIds },
    },
    overrides,
  );
  const deps: JobDeps = { config, discord, storage };
  return { deps, posts, storage };
}

test("mood polls post to every channel, record successful polls for collection, and report failures", async () => {
  const { deps, posts, storage } = fixture();
  const results = await postMoodPolls(deps, "cron");

  expect(results).toStrictEqual([
    { channelId: "good", ok: true, detail: "m1" },
    { channelId: "bad", ok: false, detail: "Missing Access" },
  ]);
  expect(posts.map((post) => post.channelId)).toStrictEqual(["good", "bad"]);
  expect(JSON.stringify(posts[0].payload)).toContain("Mood (November 5, 2026)");
  expect(await storage.getAllPendingPolls()).toStrictEqual([
    {
      messageId: "m1",
      channelId: "good",
      date: "2026-11-05",
      createdAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 24 * 60 * 60 * 1000,
      collected: false,
    },
  ]);
  expect(logs).toStrictEqual([
    'info cron: Posted poll {"channelId":"good","messageId":"m1"}',
    'info storage: Saved pending poll {"messageId":"m1","date":"2026-11-05"}',
    'error cron: Failed to post poll {"channelId":"bad","status":403,"body":"Missing Access"}',
  ]);
});

test("a mood poll already posted stays recorded when a later channel's post throws", async () => {
  const { deps, storage } = fixture();
  let calls = 0;
  deps.discord = {
    postMessage() {
      if (++calls === 2) return Promise.reject(new Error("network down"));
      return Promise.resolve(Response.json({ id: `m${calls}` }));
    },
  } as unknown as DiscordClient;

  await expect(postMoodPolls(deps, "cron")).rejects.toThrow("network down");
  expect((await storage.getAllPendingPolls()).map((poll) => poll.messageId)).toStrictEqual(["m1"]);
});

test("stats cover from N days ago through today, UTC, and log under the caller's scope", async () => {
  const storage = createStorageService(openDatabase(":memory:"));
  for (const [mood, date] of [
    ["ok", "2026-10-28"],
    ["glue", "2026-10-29"],
    ["ok", "2026-10-30"],
    ["glue", "2026-11-05"],
  ] as const) {
    await storage.recordVote("good", "u1", "User One", mood, date);
  }
  const { deps, posts } = fixture(storage);
  const results = await postStats(deps, {
    days: 7,
    title: "📊 Weekly Mood Summary",
    label: "weekly stats",
    scope: "cron",
  });

  expect(results).toStrictEqual([
    { channelId: "good", ok: true, detail: "m1" },
    { channelId: "bad", ok: false, detail: "Missing Access" },
  ]);
  const embed = JSON.stringify(posts[0].payload);
  expect(embed).toContain("📊 Weekly Mood Summary");
  expect(embed).toContain("Total responses: 3");
  expect(logs).toStrictEqual([
    'info cron: Posted weekly stats {"channelId":"good","messageId":"m1"}',
    'error cron: Failed to post weekly stats {"channelId":"bad","status":403,"body":"Missing Access"}',
  ]);
});

test("the wellness check alerts each user at or over the glue streak, per channel", async () => {
  const storage = createStorageService(openDatabase(":memory:"));
  for (const date of ["2026-11-03", "2026-11-04"]) {
    await storage.recordVote("good", "u1", "User One", "glue", date);
    await storage.recordVote("bad", "u1", "User One", "glue", date);
  }
  await storage.recordVote("good", "u2", "User Two", "glue", "2026-11-04");
  const { deps, posts } = fixture(storage);
  await runWellnessCheck(deps);

  expect(posts.map((post) => post.channelId)).toStrictEqual(["good", "bad"]);
  expect(JSON.stringify(posts[0].payload)).toContain("User One");
  expect(logs).toStrictEqual([
    'info cron: Users at risk {"channelId":"good","count":1}',
    'info cron: Posted alert for User One {"channelId":"good","messageId":"m1"}',
    'info cron: Users at risk {"channelId":"bad","count":1}',
    'error cron: Failed to post alert for User One {"channelId":"bad","status":403,"body":"Missing Access"}',
  ]);
});
test("the test alert posts the named user's alert to every channel", async () => {
  const { deps, posts } = fixture();
  const results = await postTestAlert(deps, "TestUser", 3);

  expect(results).toStrictEqual([
    { channelId: "good", ok: true, detail: "m1" },
    { channelId: "bad", ok: false, detail: "Missing Access" },
  ]);
  expect(JSON.stringify(posts[0].payload)).toContain("TestUser");
  expect(logs).toStrictEqual([
    'info server: Posted alert {"channelId":"good","messageId":"m1"}',
    'error server: Failed to post alert {"channelId":"bad","status":403,"body":"Missing Access"}',
  ]);
});

test("each job posts only to its own feature's channels", async () => {
  const { deps, posts } = fixture(undefined, {
    moodPoll: { channelIds: ["poll-only"] },
    weeklyStats: { channelIds: ["stats-only"] },
    wellness: { channelIds: ["wellness-only"] },
  });
  await postMoodPolls(deps, "cron");
  await postStats(deps, { days: 7, title: "t", label: "weekly stats", scope: "cron" });
  await postTestAlert(deps, "TestUser", 3);
  expect(posts.map((post) => post.channelId)).toStrictEqual([
    "poll-only",
    "stats-only",
    "wellness-only",
  ]);
});

test("a disabled feature posts nothing and records nothing", async () => {
  const { deps, posts, storage } = fixture(undefined, {
    moodPoll: { enabled: false },
    weeklyStats: { enabled: false },
    wellness: { enabled: false },
  });
  await storage.recordVote("good", "u1", "User One", "glue", "2026-11-03");
  await storage.recordVote("good", "u1", "User One", "glue", "2026-11-04");

  expect(await postMoodPolls(deps, "cron")).toStrictEqual([]);
  expect(
    await postStats(deps, { days: 7, title: "t", label: "weekly stats", scope: "server" }),
  ).toStrictEqual([]);
  expect(await postTestAlert(deps, "TestUser", 3)).toStrictEqual([]);
  await runWellnessCheck(deps);

  expect(posts).toStrictEqual([]);
  expect(await storage.getAllPendingPolls()).toStrictEqual([]);
});
