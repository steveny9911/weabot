import { expect, test } from "bun:test";
import { openDatabase } from "./database.ts";
import { createLandmineQueries } from "./landmines.ts";

test("there are 100,000 landmines to begin and each claim uses one up", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  expect(mines.claim()).toBe(99_999);
  expect(mines.claim()).toBe(99_998);
});

test("a refunded landmine can be claimed again", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  mines.claim();
  mines.refund();
  expect(mines.claim()).toBe(99_999);
});

test("nothing is claimed once the landmines run out", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  db.run("UPDATE landmines SET remaining = 1");
  expect(mines.claim()).toBe(0);
  expect(mines.claim()).toBeNull();
});
