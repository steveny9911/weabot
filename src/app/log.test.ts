import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { log, setLogLevel } from "./log.ts";

const wasTty = process.stdout.isTTY;
const setTty = (value: boolean) =>
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });

beforeEach(() => setTty(false));
afterEach(() => {
  setTty(wasTty);
  setLogLevel("info");
});

/** Runs `fn` and returns what it wrote, as [stream, parsed JSON line] pairs. */
function captured(fn: () => void) {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    fn();
    return [
      ...out.mock.calls.map(([line]) => ["out", JSON.parse(String(line))] as const),
      ...err.mock.calls.map(([line]) => ["err", JSON.parse(String(line))] as const),
    ];
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

test("a line is JSON with the scope, level, message and fields", () => {
  const [[stream, line]] = captured(() => log.info("gateway", "Bot ready", { guilds: 2 }));
  expect(stream).toBe("out");
  expect(line).toMatchObject({ level: "info", scope: "gateway", message: "Bot ready", guilds: 2 });
  expect(new Date(line.time).toISOString()).toBe(line.time);
});

test("warnings and errors go to stderr, the rest to stdout", () => {
  setLogLevel("debug");
  const lines = captured(() => {
    log.debug("a", "d");
    log.warn("a", "w");
    log.error("a", "e");
  });
  expect(lines.map(([stream, line]) => `${stream}:${line.level}`)).toStrictEqual([
    "out:debug",
    "err:warn",
    "err:error",
  ]);
});

test("lines below the level are dropped, and the default is info", () => {
  expect(captured(() => log.debug("a", "quiet"))).toStrictEqual([]);
  setLogLevel("warn");
  expect(captured(() => log.info("a", "quiet"))).toStrictEqual([]);
  expect(captured(() => log.warn("a", "loud"))).toHaveLength(1);
});

test("an Error field keeps its name, message and stack", () => {
  const [[, line]] = captured(() => log.error("cron", "failed", { err: new TypeError("boom") }));
  expect(line.err).toMatchObject({ name: "TypeError", message: "boom" });
  expect(line.err.stack).toContain("boom");
});

test("a field cannot overwrite the level or the message", () => {
  const [[, line]] = captured(() => log.info("a", "real", { level: "fake", message: "fake" }));
  expect(line).toMatchObject({ level: "info", message: "real" });
});

test("in a terminal a line is readable text, not JSON", () => {
  setTty(true);
  const out = spyOn(console, "log").mockImplementation(() => {});
  try {
    log.info("gateway", "Bot ready", { guilds: 2 });
    const line = String(out.mock.calls[0][0]);
    expect(line).toMatch(/^\d\d:\d\d:\d\d INFO {2}\[gateway\] Bot ready .*guilds/);
  } finally {
    out.mockRestore();
  }
});
