import { expect, test } from "bun:test";
import { parseBaseline, parseJunitCounts } from "./gate.ts";

test("parseBaseline reads the bun_expected column per file", () => {
  const text = [
    "file  deno_total step_parents bun_expected",
    "src/a.test.ts                  65            6           59",
    "TOTAL unit (1 files)           65            6           59",
  ].join("\n");
  expect(parseBaseline(text)).toStrictEqual(new Map([["src/a.test.ts", 59]]));
});

test("parseJunitCounts keeps only file-level suites", () => {
  const xml = [
    '<testsuite name="src/a.test.ts" file="src/a.test.ts" tests="3" assertions="3">',
    '<testsuite name="group" file="src/a.test.ts" line="4" tests="2" assertions="2">',
  ].join("\n");
  expect(parseJunitCounts(xml)).toStrictEqual(new Map([["src/a.test.ts", 3]]));
});
