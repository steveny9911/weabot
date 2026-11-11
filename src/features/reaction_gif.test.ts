import { expect, test } from "bun:test";
import { haruGreetingGifPool, selectGreetingGifForReply } from "./reaction_gif.ts";

test("a reply that says hello, hi or ciallo gets a GIF from the pool", () => {
  for (const reply of ["Hello there!", "hI~", "CIALLO!", "just saying hi friend"]) {
    expect(selectGreetingGifForReply(reply, () => 0)).toStrictEqual(haruGreetingGifPool[0]);
  }
  const last = haruGreetingGifPool[haruGreetingGifPool.length - 1];
  expect(selectGreetingGifForReply("hi", () => 0.999999)).toStrictEqual(last);
});

test("a reply without a greeting gets no GIF", () => {
  for (const reply of ["This is a test.", "high five", ""]) {
    expect(selectGreetingGifForReply(reply)).toStrictEqual(null);
  }
});
