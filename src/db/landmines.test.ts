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

test("steps since a time are counted per user, most first, and older steps are left out", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  const add = db.query("INSERT INTO landmine_steps (user_id, stepped_at) VALUES (?, ?)");
  for (const [user, time] of [
    ["b", 100],
    ["a", 100],
    ["a", 200],
    ["c", 99],
    ["b", 300],
    ["b", 400],
  ] as const) {
    add.run(user, time);
  }
  expect(mines.stepsSince(100)).toStrictEqual([
    { userId: "b", steps: 3 },
    { userId: "a", steps: 2 },
  ]);
  expect(mines.stepsSince(1_000)).toStrictEqual([]);
});

test("the landmines remaining are readable without using one up", () => {
  using db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  mines.claim();
  expect(mines.remaining()).toBe(99_999);
  expect(mines.remaining()).toBe(99_999);
});
