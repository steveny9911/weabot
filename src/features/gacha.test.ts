import { afterEach, expect, spyOn, test } from "bun:test";
import { setSystemTime } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import { openDatabase } from "../db/database.ts";
import { createGachaPityQueries } from "../db/gacha_pity.ts";
import { createGachaService } from "./gacha.ts";

afterEach(() => setSystemTime());

const pulls = [
  { name: "克洛丝", rarity: 3 },
  { name: "能天使", rarity: 6 },
];
const rendered = { image: new Uint8Array([9]), pulls, result: { finalPity: 5 } };

/** Real pity storage, in a database of its own. */
const freshPity = () => createGachaPityQueries(openDatabase(":memory:"));

test("pull returns the image with alt text naming every operator", async () => {
  const calls: unknown[] = [];
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: (options) => (calls.push(options), Promise.resolve(rendered)),
  });
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: true,
    image: new Uint8Array([9]),
    altText: "Arknights ten-pull: 3★ 克洛丝, 6★ 能天使",
  });
  expect(calls).toStrictEqual([
    { cacheDir: "/cache", format: "webp", startPity: 0, guaranteeFiveStar: true },
  ]);
});

test("alt text is cut to Discord's 1024 characters", async () => {
  const long = Array.from({ length: 10 }, () => ({
    name: "名".repeat(200),
    rarity: 4,
  }));
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: () =>
      Promise.resolve({ image: new Uint8Array(), pulls: long, result: { finalPity: 0 } }),
  });
  const result = await gacha.pull("u1");
  assert(result.ok);
  expect(result.altText.length).toStrictEqual(1024);
});

test("a user waits out the cooldown (10 seconds by default); other users are not affected", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: () => Promise.resolve(rendered),
  });
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  setSystemTime(new Date("2026-01-01T00:00:04Z"));
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: false,
    reason: "cooldown",
    retryInMs: 6_000,
  });
  expect((await gacha.pull("u2")).ok).toStrictEqual(true);
  setSystemTime(new Date("2026-01-01T00:00:10Z"));
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
});

test("the cooldown length is configurable", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: () => Promise.resolve(rendered),
    cooldownMs: 60_000,
  });
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  setSystemTime(new Date("2026-01-01T00:00:30Z"));
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: false,
    reason: "cooldown",
    retryInMs: 30_000,
  });
});

test("a failed render is logged, reported, and costs no cooldown", async () => {
  let fail = true;
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(rendered)),
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await gacha.pull("u1")).toStrictEqual({
      ok: false,
      reason: "failed",
    });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  fail = false;
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
});

test("pulls queue and draw one at a time; those beyond the queue limit are refused", async () => {
  let running = 0;
  let peak = 0;
  const order: string[] = [];
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: async () => {
      peak = Math.max(peak, ++running);
      await Bun.sleep(2);
      running--;
      return rendered;
    },
  });
  const users = ["a", "b", "c", "d", "e", "f", "g"];
  const results = await Promise.all(
    users.map((id) => gacha.pull(id).then((r) => (order.push(id), r))),
  );
  const outcomes: string[] = results.map((r) => (r.ok ? "ok" : r.reason));
  expect(outcomes).toStrictEqual(["ok", "ok", "ok", "ok", "ok", "busy", "busy"]);
  expect(order.filter((id) => id !== "f" && id !== "g")).toStrictEqual(["a", "b", "c", "d", "e"]);
  expect(peak).toStrictEqual(1);
  expect((await gacha.pull("late")).ok).toStrictEqual(true);
});

test("a render that takes too long fails, and the pull queued behind it still runs", async () => {
  let calls = 0;
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    // Only the first render hangs.
    generate: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve(rendered)),
    renderTimeoutMs: 20,
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const [stuck, next] = await Promise.all([gacha.pull("u1"), gacha.pull("u2")]);
    expect(stuck).toStrictEqual({ ok: false, reason: "failed" });
    expect(next.ok).toStrictEqual(true);
  } finally {
    logged.mockRestore();
  }
});

test("pity carries from one pull to the next, and only the first pull has the 5-star guarantee", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const calls: Array<{ startPity: number; guaranteeFiveStar: boolean }> = [];
  let finalPity = 10;
  const pity = freshPity();
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity,
    generate: (options) => (
      calls.push(options),
      Promise.resolve({ ...rendered, result: { finalPity } })
    ),
  });
  await gacha.pull("u1");
  expect(pity.get("u1")).toStrictEqual(10);

  setSystemTime(new Date("2026-01-01T00:01:00Z"));
  finalPity = 0; // a 6-star resets it
  await gacha.pull("u1");
  expect(pity.get("u1")).toStrictEqual(0);

  setSystemTime(new Date("2026-01-01T00:02:00Z"));
  await gacha.pull("u1");
  expect(
    calls.map(({ startPity, guaranteeFiveStar }) => [startPity, guaranteeFiveStar]),
  ).toStrictEqual([
    [0, true],
    [10, false],
    [0, false],
  ]);
});

test("each user has their own pity", async () => {
  const calls: Array<{ startPity: number; guaranteeFiveStar: boolean }> = [];
  const pity = freshPity();
  pity.save("u1", 40);
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity,
    generate: (options) => (calls.push(options), Promise.resolve(rendered)),
  });
  await gacha.pull("u1");
  await gacha.pull("u2");
  expect(
    calls.map(({ startPity, guaranteeFiveStar }) => [startPity, guaranteeFiveStar]),
  ).toStrictEqual([
    [40, false],
    [0, true],
  ]);
  expect(pity.get("u2")).toStrictEqual(5);
});

test("a failed or timed-out pull leaves pity alone, so the next one is still a first pull", async () => {
  const pity = freshPity();
  const late = Promise.withResolvers<typeof rendered>();
  const generates = [
    () => Promise.reject(new Error("offline")),
    () => late.promise,
    () => Promise.resolve(rendered),
  ];
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity,
    renderTimeoutMs: 5,
    generate: () => generates.shift()!(),
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await gacha.pull("u1")).ok).toStrictEqual(false); // fails
    expect((await gacha.pull("u1")).ok).toStrictEqual(false); // times out
    late.resolve(rendered); // the render finishes after the timeout
    await Bun.sleep(0);
    expect(pity.get("u1")).toBeNull();
  } finally {
    logged.mockRestore();
  }
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  expect(pity.get("u1")).toStrictEqual(5);
});

test("a failed pull does not erase the cooldown of the pull queued behind it", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const first = Promise.withResolvers<typeof rendered>();
  let calls = 0;
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    generate: () => (++calls === 1 ? first.promise : Promise.resolve(rendered)),
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const a = gacha.pull("u1");
    setSystemTime(new Date("2026-01-01T00:00:11Z")); // A's cooldown is over, so B may queue
    const b = gacha.pull("u1");
    first.reject(new Error("offline"));
    expect((await a).ok).toStrictEqual(false);
    expect((await b).ok).toStrictEqual(true);
    expect(await gacha.pull("u1")).toMatchObject({ ok: false, reason: "cooldown" });
  } finally {
    logged.mockRestore();
  }
});

test("a user's second queued pull starts from the pity the first one left", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const starts: number[] = [];
  const gacha = createGachaService({
    cacheDir: "/cache",
    pity: freshPity(),
    cooldownMs: 1, // short enough that the user can queue again while the first pull is drawing
    generate: async (options) => {
      starts.push(options.startPity);
      await Bun.sleep(20);
      return { ...rendered, result: { finalPity: options.startPity + 10 } };
    },
  });
  const first = gacha.pull("u1");
  setSystemTime(new Date("2026-01-01T00:00:01Z"));
  const second = gacha.pull("u1");
  expect((await Promise.all([first, second])).every((r) => r.ok)).toStrictEqual(true);
  expect(starts).toStrictEqual([0, 10]);
});
