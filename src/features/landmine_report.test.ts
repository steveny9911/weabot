import { expect, test } from "bun:test";
import { buildLandmineReport, reportStart } from "./landmine_report.ts";

const at = (iso: string) => Date.parse(iso);

test("a week is the last 7 days", () => {
  expect(reportStart("week", at("2026-11-08T06:00:00Z"))).toBe(at("2026-11-01T06:00:00Z"));
});

test("a month goes back to the same moment of the month before", () => {
  expect(reportStart("month", at("2026-12-01T06:00:00Z"))).toBe(at("2026-11-01T06:00:00Z"));
  expect(reportStart("month", at("2027-01-01T06:00:00Z"))).toBe(at("2026-12-01T06:00:00Z"));
});

test("a month that started on a day the shorter month lacks starts on its last day", () => {
  expect(reportStart("month", at("2026-03-31T10:00:00Z"))).toBe(at("2026-02-28T10:00:00Z"));
});

test("the report lists the most steps first, equal counts share a rank, and shows both totals", () => {
  const { embeds } = buildLandmineReport(
    "week",
    [
      { userId: "1", steps: 7 },
      { userId: "2", steps: 4 },
      { userId: "3", steps: 4 },
      { userId: "4", steps: 2 },
    ],
    98_204,
  );
  expect(embeds).toStrictEqual([
    {
      title: "💥 Weekly Landmine Report",
      description:
        "1. <@1> — 7\n2. <@2> — 4\n2. <@3> — 4\n4. <@4> — 2\n\n" +
        "Stepped on this week: 17\nLandmines remaining: 98,204",
    },
  ]);
});

test("a monthly report says month, and an empty one says nobody stepped on a landmine", () => {
  const { embeds } = buildLandmineReport("month", [], 100_000);
  expect(embeds).toStrictEqual([
    {
      title: "💥 Monthly Landmine Report",
      description: "Nobody stepped on a landmine this month.\n\nLandmines remaining: 100,000",
    },
  ]);
});

test("only the top 20 are listed, but the total counts everyone", () => {
  const steppers = Array.from({ length: 25 }, (_, i) => ({ userId: `u${i}`, steps: 1 }));
  const [{ description }] = buildLandmineReport("week", steppers, 5).embeds;
  expect(description?.split("\n").filter((line) => line.includes("<@"))).toHaveLength(20);
  expect(description).toContain("Stepped on this week: 25");
});
