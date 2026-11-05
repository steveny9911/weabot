import { expect, setSystemTime, spyOn, test } from "bun:test";
import { openDatabase } from "../db/database.ts";
import { createMaintenanceJob } from "./maintenance.ts";

test("maintenance deletes AI usage older than 30 days, sweeps turns and logs both counts", () => {
  setSystemTime(new Date("2026-11-05T12:00:00Z"));
  const logged = spyOn(console, "log").mockImplementation(() => {});
  try {
    const db = openDatabase(":memory:");
    const insert = db.query(
      "INSERT INTO ai_daily_usage (usage_date, requests, tokens) VALUES (?, 1, 1)",
    );
    for (const date of ["2026-10-05", "2026-10-06", "2026-11-05"]) insert.run(date);
    let sweeps = 0;
    createMaintenanceJob(db, { sweep: () => (sweeps++, 2) })();
    expect(
      db.query("SELECT usage_date FROM ai_daily_usage ORDER BY usage_date").values(),
    ).toStrictEqual([["2026-10-06"], ["2026-11-05"]]);
    expect(sweeps).toBe(1);
    expect(logged.mock.calls).toStrictEqual([
      ["[MAINTENANCE] Removed 1 old AI usage day(s), 2 expired turn(s)"],
    ]);
  } finally {
    logged.mockRestore();
    setSystemTime();
  }
});
