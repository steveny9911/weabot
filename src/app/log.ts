/**
 * The one place Haru writes logs. Under Docker (no TTY) each line is a JSON object, which Dozzle
 * and `jq` can filter by level and scope; in a terminal it is a short readable line.
 */
import { inspect } from "node:util";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export const LOG_LEVELS = Object.keys(LEVELS) as LogLevel[];

let threshold: number = LEVELS.info;

/** Called once at startup with `general.log_level`; lines below it are dropped. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/** `JSON.stringify(new Error("x"))` is `{}`, so an Error field is spelled out. */
function flatten(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    ]),
  );
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < threshold) return;
  const write = level === "error" || level === "warn" ? console.error : console.log;
  if (process.stdout.isTTY) {
    const extra =
      Object.keys(fields).length > 0 ? ` ${inspect(fields, { breakLength: Infinity })}` : "";
    const time = new Date().toTimeString().slice(0, 8);
    write(`${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`);
  } else {
    // The fixed keys come last so a caller's field cannot overwrite them.
    write(
      JSON.stringify({
        ...flatten(fields),
        time: new Date().toISOString(),
        level,
        scope,
        message,
      }),
    );
  }
}

type Fields = Record<string, unknown>;

/** `scope` names the part of Haru logging, such as `gateway` or `cron`. */
export const log = {
  debug: (scope: string, message: string, fields?: Fields) => emit("debug", scope, message, fields),
  info: (scope: string, message: string, fields?: Fields) => emit("info", scope, message, fields),
  warn: (scope: string, message: string, fields?: Fields) => emit("warn", scope, message, fields),
  error: (scope: string, message: string, fields?: Fields) => emit("error", scope, message, fields),
};
