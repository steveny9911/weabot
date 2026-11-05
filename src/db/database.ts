/**
 * The process-wide SQLite database: opening, pragmas and migrations.
 *
 * `bun:sqlite` is synchronous, so a transaction never interleaves with other JavaScript. Never
 * `await` inside a transaction.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type { Database };

export const DEFAULT_DATABASE_PATH = "./data/haru.sqlite3";

/** Opens (creating if needed) and migrates the database at `path`. `":memory:"` for tests. */
export function openDatabase(path: string, migrations: readonly string[] = MIGRATIONS): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    // FULL keeps a claim made before a Discord write durable across power loss.
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

function migrate(db: Database, migrations: readonly string[]): void {
  const current = userVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this code supports (${migrations.length}).`,
    );
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    db.transaction(() => {
      // Another process may have applied this migration since the version was read above.
      if (userVersion(db) >= version) return;
      db.run(migrations[version - 1]);
      db.run(`PRAGMA user_version = ${version}`);
    }).immediate();
  }
}
