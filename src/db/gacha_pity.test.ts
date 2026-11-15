import { expect, test } from "bun:test";
import { openDatabase } from "./database.ts";
import { createGachaPityQueries } from "./gacha_pity.ts";

test("a user who never pulled has no pity", () => {
  using db = openDatabase(":memory:");
  expect(createGachaPityQueries(db).get("u1")).toBeNull();
});

test("saved pity is read back, replaced by a later save, and kept per user", () => {
  using db = openDatabase(":memory:");
  const pity = createGachaPityQueries(db);
  pity.save("u1", 10);
  pity.save("u2", 37);
  expect(pity.get("u1")).toBe(10);
  pity.save("u1", 0); // 0 is a saved pity, not "never pulled"
  expect(pity.get("u1")).toBe(0);
  expect(pity.get("u2")).toBe(37);
});

test("pity outside 0 to 98 is refused", () => {
  using db = openDatabase(":memory:");
  const pity = createGachaPityQueries(db);
  for (const bad of [-1, 99]) expect(() => pity.save("u1", bad)).toThrow();
});
