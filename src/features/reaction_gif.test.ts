import { expect, test } from "bun:test";
import {
  aszHaruGreetingGifPool,
  bHasGreetingTrigger,
  szPickRandomGreetingGif,
  szSelectGreetingGifForReply,
} from "./reaction_gif.ts";

test("bHasGreetingTrigger matches hello/hi/ciallo case-insensitively", () => {
  expect(bHasGreetingTrigger("Hello there!")).toStrictEqual(true);
  expect(bHasGreetingTrigger("hI~")).toStrictEqual(true);
  expect(bHasGreetingTrigger("CIALLO!")).toStrictEqual(true);
  expect(bHasGreetingTrigger("just saying hi friend")).toStrictEqual(true);
});

test("bHasGreetingTrigger does not match non-greeting text", () => {
  expect(bHasGreetingTrigger("This is a test.")).toStrictEqual(false);
  expect(bHasGreetingTrigger("A random message.")).toStrictEqual(false);
  expect(bHasGreetingTrigger("")).toStrictEqual(false);
});

test("szPickRandomGreetingGif always returns from fixed pool", () => {
  const samples = [0, 0.15, 0.33, 0.55, 0.79, 0.99, -1, 1, Number.NaN];
  for (const sample of samples) {
    const picked = szPickRandomGreetingGif(() => sample);
    expect(aszHaruGreetingGifPool.includes(picked)).toStrictEqual(true);
  }
});

test("szPickRandomGreetingGif handles edge samples deterministically", () => {
  expect(szPickRandomGreetingGif(() => 0)).toStrictEqual(aszHaruGreetingGifPool[0]);
  expect(szPickRandomGreetingGif(() => 0.999999)).toStrictEqual(
    aszHaruGreetingGifPool[aszHaruGreetingGifPool.length - 1],
  );
  expect(szPickRandomGreetingGif(() => 1)).toStrictEqual(
    aszHaruGreetingGifPool[aszHaruGreetingGifPool.length - 1],
  );
  expect(szPickRandomGreetingGif(() => -0.25)).toStrictEqual(aszHaruGreetingGifPool[0]);
});

test("szSelectGreetingGifForReply returns gif only for greeting replies", () => {
  const picked = szSelectGreetingGifForReply("Ciallo there!", () => 0);
  expect(picked).toStrictEqual(aszHaruGreetingGifPool[0]);
  expect(szSelectGreetingGifForReply("No greeting here.")).toStrictEqual(null);
});
