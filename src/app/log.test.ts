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
    log.debug("cron", "d");
    log.warn("cron", "w");
    log.error("cron", "e");
  });
  expect(lines.map(([stream, line]) => `${stream}:${line.level}`)).toStrictEqual([
    "out:debug",
    "err:warn",
    "err:error",
  ]);
});

test("lines below the level are dropped, and the default is info", () => {
  expect(captured(() => log.debug("cron", "quiet"))).toStrictEqual([]);
  setLogLevel("warn");
  expect(captured(() => log.info("cron", "quiet"))).toStrictEqual([]);
  expect(captured(() => log.warn("cron", "loud"))).toHaveLength(1);
});

test("an Error field keeps its name, message and stack", () => {
  const [[, line]] = captured(() => log.error("cron", "failed", { error: new TypeError("boom") }));
  expect(line.error).toMatchObject({ name: "TypeError", message: "boom" });
  expect(line.error.stack).toContain("boom");
});

test("an Error keeps its cause, code and status, even nested in a field", () => {
  const failure = Object.assign(new Error("outer", { cause: new Error("inner") }), {
    code: "ECONNRESET",
    status: 503,
  });
  const [[, line]] = captured(() => log.error("cron", "failed", { error: { wrapped: failure } }));
  expect(line.error.wrapped).toMatchObject({ message: "outer", code: "ECONNRESET", status: 503 });
  expect(line.error.wrapped.cause.message).toBe("inner");
});

test("a BigInt is logged as a string", () => {
  const [[, line]] = captured(() => log.info("cron", "big", { n: 10n }));
  expect(line.n).toBe("10");
});

test("a cyclic field does not make the log call throw", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const [[, line]] = captured(() => log.error("cron", "cyclic", { cyclic }));
  expect(line).toMatchObject({ level: "error", scope: "cron", message: "cyclic" });
  expect(line.fields).toContain("cyclic");
});

test("a field cannot overwrite the level or the message", () => {
  const [[, line]] = captured(() => log.info("cron", "real", { level: "fake", message: "fake" }));
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
