import { afterEach, expect, spyOn, test } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import { openDatabase } from "../db/database.ts";
import { createRngQueries } from "../db/rng.ts";
import { createRngService, formatNumber, revealFrames, type RngService } from "./rng.ts";

function setup(options: { digits?: number; now?: () => number } = {}) {
  return createRngService({
    queries: createRngQueries(openDatabase(":memory:")),
    digits: options.digits ?? 6,
    timeZone: "America/Los_Angeles",
    now: options.now,
  });
}

/** A draw that is expected to be answered, and is answered at once. */
function draw(rng: RngService, userId: string) {
  const result = rng.draw(userId);
  if (!result) throw new Error("the draw was held back");
  rng.finish(userId);
  return result;
}

afterEach(() => {
  spyOn(Math, "random").mockRestore();
});

test("a number has the asked digits and never starts with 0", () => {
  for (const random of [0, 0.999999, 0.5]) {
    spyOn(Math, "random").mockReturnValue(random);
    for (const digits of [1, 6, 12]) {
      const { number } = draw(setup({ digits }), "u1");
      expect(number).toMatch(new RegExp(`^[1-9]\\d{${digits - 1}}$`));
    }
  }
  spyOn(Math, "random").mockReturnValue(0);
  expect(draw(setup(), "u1").number).toBe("100000");
});

test("a user gets the same number all day and a new one after Pacific midnight", () => {
  let now = Date.parse("2026-11-19T20:00:00Z"); // noon Pacific
  const rng = setup({ now: () => now });
  const first = draw(rng, "u1");
  expect(first.fresh).toBe(true);

  now = Date.parse("2026-11-20T07:59:00Z"); // 23:59 Pacific, still the same day
  expect(draw(rng, "u1")).toStrictEqual({ number: first.number, fresh: false });

  spyOn(Math, "random").mockReturnValue(0.5);
  now = Date.parse("2026-11-20T08:00:00Z"); // midnight Pacific
  expect(draw(rng, "u1")).toStrictEqual({ number: "555555", fresh: true });
  expect(draw(rng, "u1").fresh).toBe(false);
});

test("a user is ignored until their previous request is finished", () => {
  const rng = setup();
  const first = rng.draw("u1");
  assert(first);
  expect(first.fresh).toBe(true);

  expect(rng.draw("u1")).toBeNull();
  expect(rng.draw("u2")?.fresh).toBe(true); // another user is not held up

  rng.finish("u1");
  expect(rng.draw("u1")).toStrictEqual({ number: first.number, fresh: false });
});

test("users draw independently", () => {
  const rng = setup();
  spyOn(Math, "random").mockReturnValue(0);
  expect(draw(rng, "u1").number).toBe("100000");
  spyOn(Math, "random").mockReturnValue(0.99);
  expect(draw(rng, "u2").number).toBe("999999");
  expect(draw(rng, "u1")).toStrictEqual({ number: "100000", fresh: false });
});

test("a reveal fills in one digit at a time", () => {
  expect(revealFrames("135792")).toStrictEqual([
    "🎲1.....",
    "🎲13....",
    "🎲135...",
    "🎲1357..",
    "🎲13579.",
    "🎲**135792**",
  ]);
  expect(revealFrames("7")).toStrictEqual([formatNumber("7")]);
});
