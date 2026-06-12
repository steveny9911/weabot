/**
 * Configuration Module
 *
 * Centralizes all environment variable access with validation.
 * Implements the "Fail Fast" pattern: if required config is missing,
 * we crash immediately at startup rather than failing silently later.
 */

/** Application configuration interface */
export interface AppConfig {
  discordToken: string;
  channelId: string;
  channelIds: string[];
  timeZone: string;
  /** Number of consecutive "glue" days to trigger alert (default: 7) */
  glueAlertThreshold: number;

  // AI Safety Controls
  /** Master kill switch for AI functionality (default: true) */
  aiEnabled: boolean;
  /** OpenAI API key for AI chat responses */
  openaiApiKey: string | undefined;
  /** Max AI requests per user per minute (default: 2) */
  aiRateLimitPerUser: number;
  /** Max tokens to use per day across all users (default: 10M, user has OpenAI spending limits) */
  aiDailyTokenBudget: number;
  /** Max characters per input message before truncation; set to 0 to disable (default: 0) */
  aiMaxInputChars: number;
  /** Enable UwU-style text transformations (default: true) */
  aiEnableUwu: boolean;

  // Web Search
  /** Master switch for web search (default: false) */
  webSearchEnabled: boolean;
  /** Brave Search API key for internet lookup */
  webSearchApiKey: string | undefined;
  /** Max results returned per search (default: 3) */
  webSearchMaxResults: number;

  // Link Open
  /** Master switch for explicit link opening command (default: true) */
  linkOpenEnabled: boolean;

  // Autonomous Chat
  /** Allow Haru to speak without a direct mention during active conversations (default: false) */
  autonomousChatEnabled: boolean;
  /** Minimum recent human messages before autonomous chat can join (default: 4) */
  autonomousChatMinHumanMessages: number;
  /** Minutes used to decide whether a channel is currently active (default: 20) */
  autonomousChatActivityWindowMinutes: number;
  /** Minutes Haru waits after speaking before speaking again (default: 1) */
  autonomousChatCooldownMinutes: number;
  /** Probability [0, 1] of replying when the channel is eligible (default: 0.35) */
  autonomousChatReplyChance: number;
  /** Max recent messages sent to the AI for autonomous replies (default: 40) */
  autonomousChatMaxContextMessages: number;
}

/**
 * Retrieves an environment variable or throws a fatal error.
 * @param key - The environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is not set
 */
function getEnvOrThrow(key: string): string {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`FATAL: Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Loads and validates application configuration from environment variables.
 * Call this once at startup. If it returns, config is valid.
 * If it throws, the app should not start.
 */
export function loadConfig(): AppConfig {
  const web_search_api_key = Deno.env.get("BRAVE_SEARCH_API_KEY");
  const web_search_enabled = (Deno.env.get("WEB_SEARCH_ENABLED") ??
    (web_search_api_key ? "true" : "false")).toLowerCase() !== "false";
  const link_open_enabled = (Deno.env.get("LINK_OPEN_ENABLED") ?? "true").toLowerCase() !==
    "false";
  const parsed_autonomous_chat_reply_chance = parseFloat(
    Deno.env.get("AUTONOMOUS_CHAT_REPLY_CHANCE") ?? "0.35",
  );
  const autonomous_chat_reply_chance = Number.isFinite(parsed_autonomous_chat_reply_chance)
    ? parsed_autonomous_chat_reply_chance
    : 0.35;
  const channel_ids_raw = Deno.env.get("CHANNEL_IDS");
  const channel_id_single = Deno.env.get("CHANNEL_ID");

  let channel_ids: string[] = [];
  if (channel_ids_raw) {
    channel_ids = channel_ids_raw.split(",").map((id) => id.trim()).filter(Boolean);
  }

  if (channel_id_single && !channel_ids.includes(channel_id_single)) {
    channel_ids = channel_ids.length > 0 ? [...channel_ids, channel_id_single] : [
      channel_id_single,
    ];
  }

  if (channel_ids.length === 0) {
    throw new Error("FATAL: Missing required environment variable: CHANNEL_ID or CHANNEL_IDS");
  }

  const channel_ids_unique = [...new Set(channel_ids)];

  return {
    discordToken: getEnvOrThrow("DISCORD_TOKEN"),
    channelId: channel_ids_unique[0],
    channelIds: channel_ids_unique,
    timeZone: Deno.env.get("TIME_ZONE") ?? "America/Los_Angeles",
    glueAlertThreshold: parseInt(Deno.env.get("GLUE_ALERT_THRESHOLD") ?? "7", 10),

    // AI Safety Controls
    aiEnabled: (Deno.env.get("AI_ENABLED") ?? "true").toLowerCase() !== "false",
    openaiApiKey: Deno.env.get("OPENAI_API_KEY"),
    aiRateLimitPerUser: parseInt(Deno.env.get("AI_RATE_LIMIT_PER_USER") ?? "2", 10),
    aiDailyTokenBudget: parseInt(Deno.env.get("AI_DAILY_TOKEN_BUDGET") ?? "10000000", 10),
    aiMaxInputChars: parseInt(Deno.env.get("AI_MAX_INPUT_CHARS") ?? "0", 10),
    aiEnableUwu: (Deno.env.get("ENABLE_UWU") ?? "true").toLowerCase() !== "false",

    // Web Search
    webSearchEnabled: web_search_enabled,
    webSearchApiKey: web_search_api_key,
    webSearchMaxResults: parseInt(Deno.env.get("WEB_SEARCH_MAX_RESULTS") ?? "3", 10),

    // Link Open
    linkOpenEnabled: link_open_enabled,

    // Autonomous Chat
    autonomousChatEnabled: (Deno.env.get("AUTONOMOUS_CHAT_ENABLED") ?? "false").toLowerCase() ===
      "true",
    autonomousChatMinHumanMessages: parseInt(
      Deno.env.get("AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES") ?? "4",
      10,
    ),
    autonomousChatActivityWindowMinutes: parseInt(
      Deno.env.get("AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES") ?? "20",
      10,
    ),
    autonomousChatCooldownMinutes: parseInt(
      Deno.env.get("AUTONOMOUS_CHAT_COOLDOWN_MINUTES") ?? "1",
      10,
    ),
    autonomousChatReplyChance: Math.min(1, Math.max(0, autonomous_chat_reply_chance)),
    autonomousChatMaxContextMessages: parseInt(
      Deno.env.get("AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES") ?? "40",
      10,
    ),
  };
}
