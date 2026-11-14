import { expect, test } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import { createGachaService, GACHA_COOLDOWN_MS } from "./gacha.ts";

const pulls = [
  { name: "克洛丝", rarity: 3 },
  { name: "能天使", rarity: 6 },
];

function service(generate = () => Promise.resolve({ image: new Uint8Array([9]), pulls })) {
  let time = 1_000_000;
  const calls: Array<{ cacheDir: string }> = [];
  const created = createGachaService({
    cacheDir: "/cache",
    now: () => time,
    generate: (options) => {
      calls.push(options);
      return generate();
    },
  });
  return { gacha: created, calls, advance: (ms: number) => void (time += ms) };
}

test("pull returns the image with alt text naming every operator", async () => {
  const { gacha, calls } = service();
  const result = await gacha.pull("u1");
  expect(result).toStrictEqual({
    ok: true,
    image: new Uint8Array([9]),
    altText: "Arknights ten-pull: 3★ 克洛丝, 6★ 能天使",
  });
  expect(calls).toStrictEqual([{ cacheDir: "/cache" }]);
});

test("a user must wait for the cooldown; others and later pulls are fine", async () => {
  const { gacha, calls, advance } = service();
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  advance(10_000);
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: false,
    reason: "cooldown",
    retryInMs: GACHA_COOLDOWN_MS - 10_000,
  });
  expect((await gacha.pull("u2")).ok).toStrictEqual(true);
  advance(GACHA_COOLDOWN_MS);
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
  expect(calls.length).toStrictEqual(3);
});

test("two quick pulls by one user render once", async () => {
  const { gacha, calls } = service();
  const [first, second] = await Promise.all([gacha.pull("u1"), gacha.pull("u1")]);
  expect(first.ok).toStrictEqual(true);
  expect(second).toMatchObject({ ok: false, reason: "cooldown" });
  expect(calls.length).toStrictEqual(1);
});

test("a failed render is reported, not thrown, and does not use up the cooldown", async () => {
  let fail = true;
  const { gacha } = service(() =>
    fail
      ? Promise.reject(new Error("offline"))
      : Promise.resolve({ image: new Uint8Array(), pulls }),
  );
  expect(await gacha.pull("u1")).toStrictEqual({
    ok: false,
    reason: "failed",
    error: "Error: offline",
  });
  fail = false;
  expect((await gacha.pull("u1")).ok).toStrictEqual(true);
});

test("renders run one at a time", async () => {
  let running = 0;
  let peak = 0;
  const { gacha } = service(async () => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(5);
    running--;
    return { image: new Uint8Array(), pulls };
  });
  await Promise.all(["a", "b", "c"].map((id) => gacha.pull(id)));
  expect(peak).toStrictEqual(1);
});

test("alt text is cut to Discord's 1024 characters", async () => {
  const many = Array.from({ length: 10 }, () => ({ name: "名".repeat(200), rarity: 4 }));
  const { gacha } = service(() => Promise.resolve({ image: new Uint8Array(), pulls: many }));
  const result = await gacha.pull("u1");
  assert(result.ok);
  expect(result.altText.length).toStrictEqual(1024);
});
