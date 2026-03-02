import { assertEquals } from "@std/assert";
import {
  aszHaruGreetingGifPool,
  bHasGreetingTrigger,
  szPickRandomGreetingGif,
  szSelectGreetingGifForReply,
} from "./reaction_gif.ts";

Deno.test("bHasGreetingTrigger matches hello/hi/ciallo case-insensitively", () => {
  assertEquals(bHasGreetingTrigger("Hello there!"), true);
  assertEquals(bHasGreetingTrigger("hI~"), true);
  assertEquals(bHasGreetingTrigger("CIALLO!"), true);
  assertEquals(bHasGreetingTrigger("just saying hi friend"), true);
});

Deno.test("bHasGreetingTrigger does not match non-greeting text", () => {
  assertEquals(bHasGreetingTrigger("This is a test."), false);
  assertEquals(bHasGreetingTrigger("A random message."), false);
  assertEquals(bHasGreetingTrigger(""), false);
});

Deno.test("szPickRandomGreetingGif always returns from fixed pool", () => {
  const samples = [0, 0.15, 0.33, 0.55, 0.79, 0.99, -1, 1, Number.NaN];
  for (const sample of samples) {
    const picked = szPickRandomGreetingGif(() => sample);
    assertEquals(aszHaruGreetingGifPool.includes(picked), true);
  }
});

Deno.test("szPickRandomGreetingGif handles edge samples deterministically", () => {
  assertEquals(szPickRandomGreetingGif(() => 0), aszHaruGreetingGifPool[0]);
  assertEquals(
    szPickRandomGreetingGif(() => 0.999999),
    aszHaruGreetingGifPool[aszHaruGreetingGifPool.length - 1],
  );
  assertEquals(
    szPickRandomGreetingGif(() => 1),
    aszHaruGreetingGifPool[aszHaruGreetingGifPool.length - 1],
  );
  assertEquals(szPickRandomGreetingGif(() => -0.25), aszHaruGreetingGifPool[0]);
});

Deno.test("szSelectGreetingGifForReply returns gif only for greeting replies", () => {
  const picked = szSelectGreetingGifForReply("Ciallo there!", () => 0);
  assertEquals(picked, aszHaruGreetingGifPool[0]);
  assertEquals(szSelectGreetingGifForReply("No greeting here."), null);
});
