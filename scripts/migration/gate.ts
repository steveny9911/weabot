/**
 * Migration gate: type-checks and tests the files ported to Bun so far, and
 * compares per-file test counts with the Deno baseline. Bun silently ignores
 * a missing test file argument, so missing files and count mismatches fail
 * here. Used during the Deno-to-Bun migration only (removed in slice 5).
 *
 * Usage: bun run migration:gate
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Expected = Record<string, number | null>;
interface Ported {
  unit: Expected;
  transport: Expected;
  /** Files allowed to skip up to this many tests, e.g. where the machine has no IPv6. */
  allowedSkips?: Record<string, number>;
}

const BASELINE_PATH = "docs/bun-migration-baseline.txt";
const PORTED_PATH = "scripts/migration/ported.json";

export function parseBaseline(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\S+\.ts)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) counts.set(match[1], Number(match[4]));
  }
  return counts;
}

export interface FileCounts {
  tests: number;
  skipped: number;
}

/** File-level suites only: nested describe suites carry a `line` attribute. */
export function parseJunitCounts(xml: string): Map<string, FileCounts> {
  const counts = new Map<string, FileCounts>();
  for (const match of xml.matchAll(
    /<testsuite name="([^"]+)" file="\1" tests="(\d+)"[^>]*?\bskipped="(\d+)"/g,
  )) {
    counts.set(match[1], { tests: Number(match[2]), skipped: Number(match[3]) });
  }
  return counts;
}

/** Converted test files import bun:test, so Deno must exclude them (deno.json `exclude`). */
export function notExcludedFromDeno(files: string[], excludes: string[]): string[] {
  return files.filter(
    (file) =>
      !excludes.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)),
  );
}

function run(command: string[]): number {
  console.log(`\n$ ${command.join(" ")}`);
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  return result.exitCode ?? 1;
}

/** Bun counts skipped and todo tests in `tests`, so a skipped test would otherwise pass. */
export function skipProblem(file: string, skipped: number, allowed = 0): string | undefined {
  if (skipped > allowed) return `${file}: ${skipped} skipped or todo tests (allowed: ${allowed})`;
  if (skipped > 0) console.warn(`${file}: ${skipped} test(s) skipped, within the allowance`);
  return undefined;
}

function testGroup(
  label: string,
  expected: Expected,
  baseline: Map<string, number>,
  dir: string,
  allowedSkips: Record<string, number> = {},
) {
  const files = Object.keys(expected);
  if (files.length === 0) return [] as string[];
  const report = join(dir, `${label}.xml`);
  const problems: string[] = [];
  const exitCode = run([
    "bun",
    "test",
    "--isolate",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    ...files.map((file) => `./${file}`),
  ]);
  if (exitCode !== 0) problems.push(`${label}: bun test exited with ${exitCode}`);
  const actual = existsSync(report) ? parseJunitCounts(readFileSync(report, "utf8")) : new Map();
  for (const file of files) {
    const want = expected[file] ?? baseline.get(file);
    const got = actual.get(file);
    if (want === undefined) problems.push(`${file}: no baseline count and no explicit count`);
    else if (got?.tests !== want) {
      problems.push(`${file}: expected ${want} tests, Bun ran ${got?.tests ?? 0}`);
    }
    const skip = got ? skipProblem(file, got.skipped, allowedSkips[file]) : undefined;
    if (skip) problems.push(skip);
  }
  return problems;
}

if (import.meta.main) {
  const ported = JSON.parse(readFileSync(PORTED_PATH, "utf8")) as Ported;
  const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
  const all = [...Object.keys(ported.unit), ...Object.keys(ported.transport)];
  const problems = all.filter((file) => !existsSync(file)).map((file) => `${file}: file not found`);
  const denoConfig = JSON.parse(readFileSync("deno.json", "utf8")) as { exclude?: string[] };
  for (const file of notExcludedFromDeno(all, denoConfig.exclude ?? [])) {
    problems.push(
      `${file}: missing from deno.json "exclude" (the Deno job would fail on bun:test)`,
    );
  }

  // main.ts is checked too: no test imports it.
  if (run(["bun", "check", "--no-script", "--no-pretty", "main.ts", ...all]) !== 0) {
    problems.push("bun check reported type errors");
  }
  const dir = mkdtempSync(join(tmpdir(), "migration-gate-"));
  try {
    problems.push(...testGroup("unit", ported.unit, baseline, dir, ported.allowedSkips));
    problems.push(...testGroup("transport", ported.transport, baseline, dir, ported.allowedSkips));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const count = (group: Expected) => Object.keys(group).length;
  if (problems.length > 0) {
    console.error(`\nMigration gate FAILED:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `\nMigration gate passed: ${count(ported.unit)} unit and ${count(ported.transport)} transport files.`,
  );
}
