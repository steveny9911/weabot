import { expect, test } from "bun:test";
import { throws } from "../../../tests/support/assert.ts";
import { resolveEventTime } from "./time.ts";

test("event time follows the requested zone, including seasonal and fractional offsets", () => {
  const cases = [
    ["2025-01-05T20:30", "America/Vancouver", "2025-01-06T04:30:00.000Z"],
    ["2025-07-05T20:30:15", "America/Vancouver", "2025-07-06T03:30:15.000Z"],
    ["2025-07-05T20:30:00", "Asia/Kolkata", "2025-07-05T15:00:00.000Z"],
    ["2025-07-05T20:30:00", "UTC", "2025-07-05T20:30:00.000Z"],
  ];
  for (const [input, zone, expected] of cases) {
    expect(resolveEventTime(input, zone)).toStrictEqual(expected);
  }
});

test("event time rejects nonexistent spring-forward wall-clock times", () => {
  throws(
    () => resolveEventTime("2025-03-09T02:30:00", "America/Vancouver"),
    Error,
    "does not exist",
  );
});

test("event time asks which occurrence of a repeated fall-back time to use", () => {
  throws(
    () => resolveEventTime("2025-11-02T01:30:00", "America/Vancouver"),
    Error,
    "happens twice",
  );
  expect(resolveEventTime("2025-11-02T01:30:00-07:00", "America/Vancouver")).toStrictEqual(
    "2025-11-02T08:30:00.000Z",
  );
  expect(resolveEventTime("2025-11-02T01:30:00-08:00", "America/Vancouver")).toStrictEqual(
    "2025-11-02T09:30:00.000Z",
  );
});

test("explicit offsets must agree with the local wall-clock time and zone", () => {
  expect(resolveEventTime("2025-07-05T20:30:00Z", "UTC")).toStrictEqual("2025-07-05T20:30:00.000Z");
  for (const input of [
    "2025-07-05T20:30:00-08:00",
    "2025-07-05T20:30:00Z",
    "2025-07-05T20:30:00+25:00",
    "2025-03-09T02:30:00-08:00",
  ]) {
    throws(() => resolveEventTime(input, "America/Vancouver"), Error, "offset does not match");
  }
});

test("event time rejects invalid calendar dates, times, shapes, and timezone names", () => {
  for (const input of [
    "2025-02-29T20:00:00",
    "2025-04-31T20:00:00",
    "2025-13-01T20:00:00",
    "2025-01-00T20:00:00",
    "2025-07-05T24:00:00",
    "2025-07-05T20:60:00",
    "2025-07-05T20:00:60",
  ])
    throws(() => resolveEventTime(input, "UTC"), Error, "not valid");
  for (const input of ["tomorrow", "2025-07-05", "2025-07-05 20:00:00"]) {
    throws(() => resolveEventTime(input, "UTC"), Error, "Use a date and time");
  }
  throws(() => resolveEventTime("2025-07-05T20:00:00", "Not/A_Zone"), Error, "Which timezone");
  expect(resolveEventTime("2024-02-29T20:00:00", "UTC")).toStrictEqual("2024-02-29T20:00:00.000Z");
});
