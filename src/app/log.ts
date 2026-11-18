/**
 * The one place Haru writes logs. Under Docker (no TTY) each line is a JSON object, which Dozzle
 * and `jq` can filter by level and scope; in a terminal it is a short readable line.
 *
 * Messages are short past-tense events ("Posted poll") or "Failed to <verb>". Details go in
 * fields, not in the message; an error goes in an `error` field, as an Error or a string.
 */
import { inspect } from "node:util";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export const LOG_LEVELS = Object.keys(LEVELS) as LogLevel[];

/** The part of Haru a line is about. A new one is added here, so a typo does not compile. */
export type LogScope =
  | "main"
  | "cron"
  | "server"
  | "gateway"
  | "discord"
  | "discord_actions"
  | "bot"
  | "ai"
  | "autonomous"
  | "poll"
  | "landmine"
  | "gacha"
  | "link"
  | "tweet"
  | "search"
  | "storage"
  | "retry"
  | "maintenance";

type Fields = Record<string, unknown>;

let threshold: number = LEVELS.info;

/** Called once at startup with `general.log_level`; lines below it are dropped. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/** JSON cannot hold an Error (it becomes `{}`) or a BigInt (it throws), at any depth. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return String(value);
  if (!(value instanceof Error)) return value;
  const { name, message, stack, cause } = value;
  const { code, status } = value as { code?: unknown; status?: unknown };
  return { name, message, stack, cause, code, status };
}

function json(level: LogLevel, scope: LogScope, message: string, fields: Fields): string {
  // The fixed keys come last so a caller's field cannot overwrite them.
  const fixed = { time: new Date().toISOString(), level, scope, message };
  try {
    return JSON.stringify({ ...fields, ...fixed }, replacer);
  } catch {
    // A cyclic field: log the line anyway, because a log call must never throw.
    return JSON.stringify({ fields: inspect(fields, { depth: 2 }), ...fixed });
  }
}

function emit(level: LogLevel, scope: LogScope, message: string, fields: Fields = {}): void {
  if (LEVELS[level] < threshold) return;
  const write = level === "error" || level === "warn" ? console.error : console.log;
  if (process.stdout.isTTY) {
    const extra =
      Object.keys(fields).length > 0 ? ` ${inspect(fields, { breakLength: Infinity })}` : "";
    const time = new Date().toTimeString().slice(0, 8);
    write(`${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`);
  } else {
    write(json(level, scope, message, fields));
  }
}

export const log = {
  debug: (scope: LogScope, message: string, fields?: Fields) =>
    emit("debug", scope, message, fields),
  info: (scope: LogScope, message: string, fields?: Fields) => emit("info", scope, message, fields),
  warn: (scope: LogScope, message: string, fields?: Fields) => emit("warn", scope, message, fields),
  error: (scope: LogScope, message: string, fields?: Fields) =>
    emit("error", scope, message, fields),
};
