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

  return {
    discordToken: getEnvOrThrow("DISCORD_TOKEN"),
    channelId: getEnvOrThrow("CHANNEL_ID"),
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
  };
}
