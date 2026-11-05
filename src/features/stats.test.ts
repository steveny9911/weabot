/**
 * Stats Embed Unit Tests
 *
 * Tests the embed builder functions.
 * These are pure functions, so no mocking needed.
 */

import { expect, test } from "bun:test";
import { buildAlertEmbed, buildStatsEmbed } from "./stats.ts";
import type { DailyStats } from "../types/storage.ts";

// ============================================================================
// buildStatsEmbed Tests
// ============================================================================

test("buildStatsEmbed returns correct structure with empty stats", () => {
  const stats: DailyStats[] = [];
  const result = buildStatsEmbed(stats);

  expect(result.embeds.length).toStrictEqual(1);
  expect(result.embeds[0].title).toStrictEqual("📊 Mood Stats");
  expect(result.embeds[0].description).toStrictEqual("Total responses: 0");
  expect(result.embeds[0].color).toStrictEqual(0x808080); // Gray for no data
});
test("buildStatsEmbed calculates totals correctly", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 3, ok: 2, glue: 1, total: 6 },
    { date: "2025-12-11", umazing: 2, ok: 3, glue: 2, total: 7 },
  ];
  const result = buildStatsEmbed(stats);

  expect(result.embeds[0].description).toStrictEqual("Total responses: 13");
});

test("buildStatsEmbed shows green color when umazing dominates", () => {
  const stats: DailyStats[] = [{ date: "2025-12-10", umazing: 10, ok: 2, glue: 1, total: 13 }];
  const result = buildStatsEmbed(stats);

  expect(result.embeds[0].color).toStrictEqual(0x00ff00); // Green
});
test("buildStatsEmbed shows red color when glue dominates", () => {
  const stats: DailyStats[] = [{ date: "2025-12-10", umazing: 1, ok: 2, glue: 10, total: 13 }];
  const result = buildStatsEmbed(stats);

  expect(result.embeds[0].color).toStrictEqual(0xff6b6b); // Red
});
test("buildStatsEmbed adds Recent Days field for multiple days", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 5, ok: 3, glue: 2, total: 10 },
    { date: "2025-12-11", umazing: 3, ok: 4, glue: 3, total: 10 },
  ];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  expect(fields.length).toStrictEqual(4);
  expect(fields[3].name).toStrictEqual("📅 Recent Days");
});
test("buildStatsEmbed percentage bar calculates correctly", () => {
  const stats: DailyStats[] = [{ date: "2025-12-10", umazing: 5, ok: 3, glue: 2, total: 10 }];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  // 5/10 = 50%
  expect(fields[0].value).toContain("50%");
  expect(fields[0].value).toContain("(5)");

  // 3/10 = 30%
  expect(fields[1].value).toContain("30%");
  expect(fields[1].value).toContain("(3)");

  // 2/10 = 20%
  expect(fields[2].value).toContain("20%");
  expect(fields[2].value).toContain("(2)");
});
test("buildStatsEmbed shows correct emoji for dominant mood in recent days", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 10, ok: 1, glue: 1, total: 12 }, // umazing wins -> 🌟
    { date: "2025-12-11", umazing: 1, ok: 10, glue: 1, total: 12 }, // ok wins -> 😐
    { date: "2025-12-12", umazing: 1, ok: 1, glue: 10, total: 12 }, // glue wins -> 🩹
  ];
  const result = buildStatsEmbed(stats);
  const recentDaysField = result.embeds[0].fields![3];

  expect(recentDaysField.value).toContain("2025-12-10: 🌟");
  expect(recentDaysField.value).toContain("2025-12-11: 😐");
  expect(recentDaysField.value).toContain("2025-12-12: 🩹");
});

// ============================================================================
// buildAlertEmbed Tests
// ============================================================================

test("buildAlertEmbed returns correct structure", () => {
  const result = buildAlertEmbed("TestUser", 7);

  expect(result.embeds.length).toStrictEqual(1);
  expect(result.embeds[0].title).toStrictEqual("💙 Wellness Check");
  expect(result.embeds[0].color).toStrictEqual(0x5865f2); // Discord blurple
});

test("buildAlertEmbed includes username in description", () => {
  const result = buildAlertEmbed("Alice", 7);

  expect(result.embeds[0].description!).toContain("**Alice**");
});
