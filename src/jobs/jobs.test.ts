import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { openDatabase } from "../db/database.ts";
import type { DiscordClient, MessagePayload } from "../discord/client.ts";
import { createStorageService, type StorageService } from "../services/storage.ts";
import type { JobDeps } from "./channel_posts.ts";
import { postMoodPolls } from "./mood_poll.ts";
import { postStats } from "./stats.ts";
import { postTestAlert, runWellnessCheck } from "./wellness.ts";

const NOW = new Date("2026-11-05T05:00:00Z");
let logs: string[];
let restore: (() => void)[];

beforeEach(() => {
  setSystemTime(NOW);
  logs = [];
  restore = (["log", "error"] as const).map((level) => {
    const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(`${level}: ${args.join(" ")}`);
    });
    return () => spy.mockRestore();
  });
});
afterEach(() => {
  for (const undo of restore) undo();
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

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

test("mood polls post to every channel, record successful polls for collection, and report failures", async () => {
  const { deps, posts, storage } = fixture();
  const results = await postMoodPolls(deps, dateFormatter, "[CRON]");

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
    "log: [STORAGE] Saved pending poll m1 for 2026-11-05",
    "log: [CRON] Poll posted in good! Message ID: m1",
    "error: [CRON] Failed to post poll in bad: 403",
    "error: Missing Access",
  ]);
});

test("stats cover the last N UTC days and log with the caller's tag and label", async () => {
  const storage = createStorageService(openDatabase(":memory:"));
  await storage.recordVote("good", "u1", "User One", "ok", "2026-10-29");
  await storage.recordVote("good", "u1", "User One", "glue", "2026-11-05");
  const { deps, posts } = fixture(storage);
  const results = await postStats(deps, {
    days: 7,
    title: "📊 Weekly Mood Summary",
    label: "weekly stats",
    tag: "[CRON]",
  });

  expect(results).toStrictEqual([
    { channelId: "good", ok: true, detail: "" },
    { channelId: "bad", ok: false, detail: "Missing Access" },
  ]);
  const embed = JSON.stringify(posts[0].payload);
  expect(embed).toContain("📊 Weekly Mood Summary");
  expect(embed).toContain("Total responses: 2");
  expect(logs).toStrictEqual([
    "log: [CRON] Weekly stats posted in good!",
    "error: [CRON] Failed to post weekly stats in bad: 403",
    "error: Missing Access",
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
    "log: [CRON] Found 1 user(s) at risk in good",
    "log: [CRON] Alert sent for User One in good",
    "log: [CRON] Found 1 user(s) at risk in bad",
    "error: [CRON] Failed to send alert for User One in bad",
  ]);
});
test("the test alert posts the named user's alert to every channel", async () => {
  const { deps, posts } = fixture();
  const results = await postTestAlert(deps, "TestUser", 3);

  expect(results).toStrictEqual([
    { channelId: "good", ok: true, detail: "" },
    { channelId: "bad", ok: false, detail: "Missing Access" },
  ]);
  expect(JSON.stringify(posts[0].payload)).toContain("TestUser");
  expect(logs).toStrictEqual([
    "log: [SERVER] Alert posted in good!",
    "error: [SERVER] Failed to post alert in bad: 403",
  ]);
});

test("each job posts only to its own feature's channels", async () => {
  const { deps, posts } = fixture(undefined, {
    moodPoll: { channelIds: ["poll-only"] },
    weeklyStats: { channelIds: ["stats-only"] },
    wellness: { channelIds: ["wellness-only"] },
  });
  await postMoodPolls(deps, dateFormatter, "[CRON]");
  await postStats(deps, { days: 7, title: "t", label: "weekly stats", tag: "[CRON]" });
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

  expect(await postMoodPolls(deps, dateFormatter, "[CRON]")).toStrictEqual([]);
  expect(
    await postStats(deps, { days: 7, title: "t", label: "weekly stats", tag: "[SERVER]" }),
  ).toStrictEqual([]);
  expect(await postTestAlert(deps, "TestUser", 3)).toStrictEqual([]);
  await runWellnessCheck(deps);

  expect(posts).toStrictEqual([]);
  expect(await storage.getAllPendingPolls()).toStrictEqual([]);
});
