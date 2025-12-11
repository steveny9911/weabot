/**
 * Stats Embed Unit Tests
 *
 * Tests the embed builder functions.
 * These are pure functions, so no mocking needed.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildAlertEmbed, buildStatsEmbed } from "./embed.ts";
import type { DailyStats } from "../../types/storage.ts";

// ============================================================================
// buildStatsEmbed Tests
// ============================================================================

Deno.test("buildStatsEmbed returns correct structure with empty stats", () => {
  const stats: DailyStats[] = [];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds.length, 1);
  assertEquals(result.embeds[0].title, "📊 Mood Stats");
  assertEquals(result.embeds[0].description, "Total responses: 0");
  assertEquals(result.embeds[0].color, 0x808080); // Gray for no data
});

Deno.test("buildStatsEmbed uses custom title", () => {
  const stats: DailyStats[] = [];
  const result = buildStatsEmbed(stats, "Custom Title");

  assertEquals(result.embeds[0].title, "Custom Title");
});

Deno.test("buildStatsEmbed calculates totals correctly", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 3, ok: 2, glue: 1, total: 6 },
    { date: "2025-12-11", umazing: 2, ok: 3, glue: 2, total: 7 },
  ];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds[0].description, "Total responses: 13");
});

Deno.test("buildStatsEmbed shows green color when umazing dominates", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 10, ok: 2, glue: 1, total: 13 },
  ];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds[0].color, 0x00ff00); // Green
});

Deno.test("buildStatsEmbed shows yellow color when ok dominates", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 2, ok: 10, glue: 3, total: 15 },
  ];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds[0].color, 0xffcc00); // Yellow
});

Deno.test("buildStatsEmbed shows red color when glue dominates", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 1, ok: 2, glue: 10, total: 13 },
  ];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds[0].color, 0xff6b6b); // Red
});

Deno.test("buildStatsEmbed has 3 mood fields for single day", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 5, ok: 3, glue: 2, total: 10 },
  ];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  assertEquals(fields.length, 3);
  assertEquals(fields[0].name, "🌟 Umazing");
  assertEquals(fields[1].name, "😐 Ok");
  assertEquals(fields[2].name, "🩹 Glue");
});

Deno.test("buildStatsEmbed adds Recent Days field for multiple days", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 5, ok: 3, glue: 2, total: 10 },
    { date: "2025-12-11", umazing: 3, ok: 4, glue: 3, total: 10 },
  ];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  assertEquals(fields.length, 4);
  assertEquals(fields[3].name, "📅 Recent Days");
});

Deno.test("buildStatsEmbed percentage bar shows 'No data' for zero total", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 0, ok: 0, glue: 0, total: 0 },
  ];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  assertEquals(fields[0].value, "No data");
  assertEquals(fields[1].value, "No data");
  assertEquals(fields[2].value, "No data");
});

Deno.test("buildStatsEmbed percentage bar calculates correctly", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 5, ok: 3, glue: 2, total: 10 },
  ];
  const result = buildStatsEmbed(stats);
  const fields = result.embeds[0].fields!;

  // 5/10 = 50%
  assertStringIncludes(fields[0].value, "50%");
  assertStringIncludes(fields[0].value, "(5)");

  // 3/10 = 30%
  assertStringIncludes(fields[1].value, "30%");
  assertStringIncludes(fields[1].value, "(3)");

  // 2/10 = 20%
  assertStringIncludes(fields[2].value, "20%");
  assertStringIncludes(fields[2].value, "(2)");
});

Deno.test("buildStatsEmbed includes footer", () => {
  const stats: DailyStats[] = [];
  const result = buildStatsEmbed(stats);

  assertEquals(result.embeds[0].footer?.text, "Weabot • Mood Tracker");
});

Deno.test("buildStatsEmbed includes timestamp", () => {
  const stats: DailyStats[] = [];
  const result = buildStatsEmbed(stats);

  // Should be a valid ISO timestamp
  const timestamp = result.embeds[0].timestamp!;
  const date = new Date(timestamp);
  assertEquals(isNaN(date.getTime()), false);
});

Deno.test("buildStatsEmbed shows correct emoji for dominant mood in recent days", () => {
  const stats: DailyStats[] = [
    { date: "2025-12-10", umazing: 10, ok: 1, glue: 1, total: 12 }, // umazing wins -> 🌟
    { date: "2025-12-11", umazing: 1, ok: 10, glue: 1, total: 12 }, // ok wins -> 😐
    { date: "2025-12-12", umazing: 1, ok: 1, glue: 10, total: 12 }, // glue wins -> 🩹
  ];
  const result = buildStatsEmbed(stats);
  const recentDaysField = result.embeds[0].fields![3];

  assertStringIncludes(recentDaysField.value, "2025-12-10: 🌟");
  assertStringIncludes(recentDaysField.value, "2025-12-11: 😐");
  assertStringIncludes(recentDaysField.value, "2025-12-12: 🩹");
});

// ============================================================================
// buildAlertEmbed Tests
// ============================================================================

Deno.test("buildAlertEmbed returns correct structure", () => {
  const result = buildAlertEmbed("TestUser", 7);

  assertEquals(result.embeds.length, 1);
  assertEquals(result.embeds[0].title, "💙 Wellness Check");
  assertEquals(result.embeds[0].color, 0x5865f2); // Discord blurple
});

Deno.test("buildAlertEmbed includes username in description", () => {
  const result = buildAlertEmbed("Alice", 7);

  assertStringIncludes(result.embeds[0].description!, "**Alice**");
});

Deno.test("buildAlertEmbed includes consecutive days count", () => {
  const result = buildAlertEmbed("Bob", 10);

  assertStringIncludes(result.embeds[0].description!, "10 days");
});

Deno.test("buildAlertEmbed has Resources field", () => {
  const result = buildAlertEmbed("TestUser", 7);
  const fields = result.embeds[0].fields!;

  assertEquals(fields.length, 1);
  assertEquals(fields[0].name, "Resources");
  assertStringIncludes(fields[0].value, "Talk to someone");
});

Deno.test("buildAlertEmbed has footer", () => {
  const result = buildAlertEmbed("TestUser", 7);

  assertStringIncludes(result.embeds[0].footer!.text, "automated wellness check");
});
