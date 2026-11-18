import { spyOn } from "bun:test";
import { type LogLevel, setLogLevel } from "../../src/app/log.ts";

/**
 * Collects what `log` writes as `level scope: message {fields}` lines, in the JSON form Docker
 * gets, whether or not the test runs in a terminal. Call `restore` when done.
 */
export function captureLogs(level: LogLevel = "info") {
  const lines: string[] = [];
  const wasTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  setLogLevel(level);
  const spies = (["log", "error"] as const).map((stream) =>
    spyOn(console, stream).mockImplementation((line: unknown) => {
      const { level, scope, message, time: _time, ...fields } = JSON.parse(String(line));
      const extra = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
      lines.push(`${level} ${scope}: ${message}${extra}`);
    }),
  );
  return {
    lines,
    restore() {
      for (const spy of spies) spy.mockRestore();
      Object.defineProperty(process.stdout, "isTTY", { value: wasTty, configurable: true });
      setLogLevel("info");
    },
  };
}
