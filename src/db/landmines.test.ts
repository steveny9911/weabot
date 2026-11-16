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

test("a recorded step keeps who stepped and when", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  const before = Date.now();
  mines.recordStep("user-1");
  const rows = db
    .query<{ user_id: string; stepped_at: number }, []>("SELECT * FROM landmine_steps")
    .all();
  expect(rows.map((r) => r.user_id)).toStrictEqual(["user-1"]);
  expect(rows[0].stepped_at).toBeGreaterThanOrEqual(before);
});
