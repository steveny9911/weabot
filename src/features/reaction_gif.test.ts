import { expect, test } from "bun:test";
import {
  haruGreetingGifPool,
  hasGreetingTrigger,
  pickRandomGreetingGif,
  selectGreetingGifForReply,
} from "./reaction_gif.ts";

test("hasGreetingTrigger matches hello/hi/ciallo case-insensitively", () => {
  expect(hasGreetingTrigger("Hello there!")).toStrictEqual(true);
  expect(hasGreetingTrigger("hI~")).toStrictEqual(true);
  expect(hasGreetingTrigger("CIALLO!")).toStrictEqual(true);
  expect(hasGreetingTrigger("just saying hi friend")).toStrictEqual(true);
});

test("hasGreetingTrigger does not match non-greeting text", () => {
  expect(hasGreetingTrigger("This is a test.")).toStrictEqual(false);
  expect(hasGreetingTrigger("A random message.")).toStrictEqual(false);
  expect(hasGreetingTrigger("")).toStrictEqual(false);
});

test("pickRandomGreetingGif always returns from fixed pool", () => {
  const samples = [0, 0.15, 0.33, 0.55, 0.79, 0.99, -1, 1, Number.NaN];
  for (const sample of samples) {
    const picked = pickRandomGreetingGif(() => sample);
    expect(haruGreetingGifPool.includes(picked)).toStrictEqual(true);
  }
});

test("pickRandomGreetingGif handles edge samples deterministically", () => {
  expect(pickRandomGreetingGif(() => 0)).toStrictEqual(haruGreetingGifPool[0]);
  expect(pickRandomGreetingGif(() => 0.999999)).toStrictEqual(
    haruGreetingGifPool[haruGreetingGifPool.length - 1],
  );
  expect(pickRandomGreetingGif(() => 1)).toStrictEqual(
    haruGreetingGifPool[haruGreetingGifPool.length - 1],
  );
  expect(pickRandomGreetingGif(() => -0.25)).toStrictEqual(haruGreetingGifPool[0]);
});

test("selectGreetingGifForReply returns gif only for greeting replies", () => {
  const picked = selectGreetingGifForReply("Ciallo there!", () => 0);
  expect(picked).toStrictEqual(haruGreetingGifPool[0]);
  expect(selectGreetingGifForReply("No greeting here.")).toStrictEqual(null);
});
