import { afterEach, expect, spyOn, test } from "bun:test";
import { setSystemTime } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import { createGachaService } from "./gacha.ts";

afterEach(() => setSystemTime());

const pulls = [
  { name: "克洛丝", rarity: 3 },
  { name: "能天使", rarity: 6 },
];
const rendered = { image: new Uint8Array([9]), pulls };

test("pull returns the image with alt text naming every operator", async () => {
  const calls: unknown[] = [];
  const gacha = createGachaService({
    cacheDir: "/cache",
    generate: (options) => (calls.push(options), Promise.resolve(rendered)),
  });
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: true,
    image: new Uint8Array([9]),
    altText: "Arknights ten-pull: 3★ 克洛丝, 6★ 能天使",
  });
  expect(calls).toStrictEqual([{ cacheDir: "/cache" }]);
});

test("alt text is cut to Discord's 1024 characters", async () => {
  const long = Array.from({ length: 10 }, () => ({ name: "名".repeat(200), rarity: 4 }));
  const gacha = createGachaService({
    cacheDir: "/cache",
    generate: () => Promise.resolve({ image: new Uint8Array(), pulls: long }),
  });
  const result = await gacha.pull("u1");
  assert(result.ok);
  expect(result.altText.length).toStrictEqual(1024);
});

test("a user waits out the cooldown; other users are not affected", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const gacha = createGachaService({
    cacheDir: "/cache",
    generate: () => Promise.resolve(rendered),
  });
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  setSystemTime(new Date("2026-01-01T00:00:10Z"));
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: false,
    reason: "cooldown",
    retryInMs: 20_000,
  });
  expect((await gacha.pull("u2")).ok).toStrictEqual(true);
  setSystemTime(new Date("2026-01-01T00:00:30Z"));
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
});

test("a failed render is logged, reported, and costs no cooldown", async () => {
  let fail = true;
  const gacha = createGachaService({
    cacheDir: "/cache",
    generate: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(rendered)),
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await gacha.pull("u1")).toStrictEqual({ ok: false, reason: "failed" });
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
