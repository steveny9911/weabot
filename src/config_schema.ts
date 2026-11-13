/** Checks config.yaml for typos: unknown keys, and an `enabled` that is not true or false. */
import type { ConfigFile } from "./config.ts";

/** The keys of `T`, as nested objects with `true` for each setting that is not a section. */
type Keys<T> = {
  [K in keyof Required<T>]: Required<T>[K] extends string | number | boolean | unknown[]
    ? true
    : Keys<Required<T>[K]>;
};

/**
 * Every key config.yaml accepts. Typed from `ConfigFile`, so adding a setting there fails to
 * compile until it is listed here.
 */
const KEYS: Keys<ConfigFile> = {
  discord: { channel_ids: true },
  general: { time_zone: true, db_path: true, http_port: true },
  ai: {
    enabled: true,
    provider: true,
    models: true,
    preset: true,
    system_prompt_file: true,
    thinking: true,
    uwu: true,
    rate_limit_per_user: true,
    max_input_chars: true,
    context: { max_messages: true, inactivity_minutes: true },
    budget: { daily_tokens: true, daily_request_quota: true, mention_percent: true },
  },
  web_search: { enabled: true, channel_ids: true, max_results: true },
  link_open: { enabled: true, channel_ids: true },
  tweet_read: { enabled: true, channel_ids: true },
  discord_actions: { enabled: true, channel_ids: true, guild_ids: true },
  usage: { openai_project_id: true },
  mood_poll: { enabled: true, channel_ids: true },
  wellness: { enabled: true, channel_ids: true, glue_alert_threshold: true },
  weekly_stats: { enabled: true, channel_ids: true },
  ai_chat: { enabled: true, channel_ids: true },
  autonomous_chat: {
    enabled: true,
    channel_ids: true,
    reply_chance: true,
    min_human_messages: true,
    activity_window_minutes: true,
    cooldown_minutes: true,
    max_context_messages: true,
    request_percent: true,
  },
  landmine: {
    enabled: true,
    channel_ids: true,
    chance: true,
    gifs: true,
    step_penalty: { enabled: true, timeout_seconds: true },
  },
};

interface KeyTree {
  [key: string]: true | KeyTree;
}

/** A missing or null value uses the default, so only a wrong value is an error. */
function check(path: string, value: unknown, keys: KeyTree): void {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FATAL: ${path} in config.yaml must be a section with settings under it`);
  }
  for (const [key, setting] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    const allowed = keys[key];
    if (allowed === undefined) {
      const known = Object.keys(keys).join(", ");
      throw new Error(
        `FATAL: Unknown setting ${where} in config.yaml (${path || "top level"} accepts: ${known})`,
      );
    }
    if (allowed !== true) check(where, setting, allowed);
    else if (key === "enabled" && setting != null && typeof setting !== "boolean") {
      throw new Error(`FATAL: ${where} in config.yaml must be true or false`);
    }
  }
}

/** Throws for a key Haru does not know, so a typo cannot silently leave a setting at its default. */
export function validateConfigFile(file: unknown): void {
  check("", file, KEYS);
}
