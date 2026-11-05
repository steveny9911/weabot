import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { throws } from "../../test_support/assert.ts";
import { openDatabase } from "./database.ts";
import { MIGRATIONS } from "./migrations.ts";

function withDirectory(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "haru-db-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pragma = (db: Database, name: string) =>
  Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

test("a new database is migrated to the latest version with all seven tables", () => {
  using db = openDatabase(":memory:");
  expect(pragma(db, "user_version")).toBe(MIGRATIONS.length);
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toStrictEqual([
    "ai_daily_usage",
    "autonomous_participation",
    "context_resets",
    "discord_action_operations",
    "discord_event_guards",
    "polls",
    "votes",
  ]);
});

test("a database file is created with its directory and uses WAL, FULL sync and a busy timeout", () => {
  withDirectory((dir) => {
    using db = openDatabase(join(dir, "data", "haru.sqlite3"));
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "synchronous")).toBe(2);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
  });
});

test("reopening a database keeps its data and applies no migration twice", () => {
  withDirectory((dir) => {
    const path = join(dir, "haru.sqlite3");
    {
      using db = openDatabase(path);
      db.run("INSERT INTO context_resets VALUES ('channel', 'message', 1)");
    }
    using db = openDatabase(path);
    expect(pragma(db, "user_version")).toBe(MIGRATIONS.length);
    expect(db.query("SELECT COUNT(*) AS n FROM context_resets").get()).toStrictEqual({ n: 1 });
  });
});

test("a database newer than the code is refused", () => {
  withDirectory((dir) => {
    const path = join(dir, "haru.sqlite3");
    {
      using db = new Database(path);
      db.run(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    }
    throws(() => openDatabase(path), Error, "newer than this code supports");
  });
});

test("a failing migration is rolled back and later migrations do not run", () => {
  withDirectory((dir) => {
    const path = join(dir, "haru.sqlite3");
    const migrations = [
      "CREATE TABLE first (x INTEGER) STRICT;",
      "CREATE TABLE second (x INTEGER) STRICT; INSERT INTO missing VALUES (1);",
      "CREATE TABLE third (x INTEGER) STRICT;",
    ];
    throws(() => openDatabase(path, migrations), Error, "no such table: missing");
    using db = new Database(path);
    expect(pragma(db, "user_version")).toBe(1);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables).toStrictEqual([{ name: "first" }]);
  });
});

test("constraints reject invalid moods, states, JSON, counters and column types", () => {
  using db = openDatabase(":memory:");
  const rejected = [
    "INSERT INTO votes VALUES ('c', '2026-01-01', 'u', 'n', 'sad', 1)",
    "INSERT INTO discord_action_operations VALUES ('g', 'm', 'a', 'running', NULL, 1)",
    "INSERT INTO discord_action_operations VALUES ('g', 'm', 'a', 'done', '{bad', 1)",
    "INSERT INTO discord_event_guards VALUES ('g', 'other', 'k', 'done', NULL, 1)",
    "INSERT INTO ai_daily_usage VALUES ('2026-01-01', -1, 0)",
    "INSERT INTO ai_daily_usage VALUES ('2026-01-01', 0, 9007199254740992)",
    "INSERT INTO polls VALUES ('m', 'c', '2026-01-01', 'soon', 1, NULL)",
    "INSERT INTO context_resets VALUES ('c', NULL, 1)",
  ];
  for (const sql of rejected) {
    expect(() => db.run(sql)).toThrow();
  }
  db.run("INSERT INTO votes VALUES ('c', '2026-01-01', 'u', 'n', 'glue', 1)");
  expect(() => db.run("INSERT INTO votes VALUES ('c', '2026-01-01', 'u', 'n', 'ok', 2)")).toThrow(
    "UNIQUE constraint failed",
  );
});
