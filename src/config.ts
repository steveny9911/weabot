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
  /** HTTP administration is disabled unless this bearer token is configured. */
  adminHttpToken?: string;
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
  /** Soft daily threshold on reported tokens; in-flight requests may exceed it (default: 10M) */
  aiDailyTokenBudget: number;
  /** Max characters per input message before truncation; set to 0 to disable (default: 0) */
  aiMaxInputChars: number;
  /** Enable UwU-style text transformations (default: true) */
  aiEnableUwu: boolean;
  /** Max messages retained from the current uninterrupted conversation (default: 40) */
  aiContextMaxMessages: number;
  /** Minutes of silence that starts a new conversation context (default: 20) */
  aiContextInactivityMinutes: number;

  /** Organization admin key for billing/usage reads; separate from the chat key. */
  openaiAdminKey?: string;
  /** Optional project filter applied to both OpenAI costs and token totals. */
  usageOpenaiProjectId?: string;

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

  /** Explicit Discord event/invite tools (default: true). */
  discordActionsEnabled?: boolean;
  /** Optional server allowlist for event/invite actions; empty allows all joined servers. */
  discordActionsGuildIds?: string[];

  // Autonomous Chat
  /** Allow Haru to speak without a direct mention during active conversations (default: false) */
  autonomousChatEnabled: boolean;
  /** Channels where autonomous chat is allowed (default: all configured channels) */
  autonomousChatChannelIds: string[];
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
  /** Wait briefly for a human message burst to finish before consuming it. */
  autonomousChatSettleSeconds?: number;
}

/**
 * Retrieves an environment variable or throws a fatal error.
 * @param key - The environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is not set
 */
function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`FATAL: Missing required environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Loads and validates application configuration from environment variables.
 * Call this once at startup. If it returns, config is valid.
 * If it throws, the app should not start.
 */
export function loadConfig(): AppConfig {
  const webSearchApiKey = process.env.BRAVE_SEARCH_API_KEY;
  const webSearchEnabled =
    (process.env.WEB_SEARCH_ENABLED ?? (webSearchApiKey ? "true" : "false")).toLowerCase() !==
    "false";
  const linkOpenEnabled = (process.env.LINK_OPEN_ENABLED ?? "true").toLowerCase() !== "false";
  const parsedAutonomousChatReplyChance = parseFloat(
    process.env.AUTONOMOUS_CHAT_REPLY_CHANCE ?? "0.35",
  );
  const autonomousChatReplyChance = Number.isFinite(parsedAutonomousChatReplyChance)
    ? parsedAutonomousChatReplyChance
    : 0.35;
  const channelIdsRaw = process.env.CHANNEL_IDS;
  const channelIdSingle = process.env.CHANNEL_ID;

  let channelIds: string[] = [];
  if (channelIdsRaw) {
    channelIds = channelIdsRaw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }

  if (channelIdSingle && !channelIds.includes(channelIdSingle)) {
    channelIds = channelIds.length > 0 ? [...channelIds, channelIdSingle] : [channelIdSingle];
  }

  if (channelIds.length === 0) {
    throw new Error("FATAL: Missing required environment variable: CHANNEL_ID or CHANNEL_IDS");
  }

  const channelIdsUnique = [...new Set(channelIds)];
  const autonomousChatChannelIdsRaw = process.env.AUTONOMOUS_CHAT_CHANNEL_IDS;
  const autonomousChatChannelIds = autonomousChatChannelIdsRaw
    ? autonomousChatChannelIdsRaw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : channelIdsUnique;

  return {
    discordToken: getEnvOrThrow("DISCORD_TOKEN"),
    adminHttpToken: process.env.ADMIN_HTTP_TOKEN?.trim() || undefined,
    channelId: channelIdsUnique[0],
    channelIds: channelIdsUnique,
    timeZone: process.env.TIME_ZONE ?? "America/Los_Angeles",
    glueAlertThreshold: parseInt(process.env.GLUE_ALERT_THRESHOLD ?? "7", 10),

    // AI Safety Controls
    aiEnabled: (process.env.AI_ENABLED ?? "true").toLowerCase() !== "false",
    openaiApiKey: process.env.OPENAI_API_KEY,
    aiRateLimitPerUser: parseInt(process.env.AI_RATE_LIMIT_PER_USER ?? "2", 10),
    aiDailyTokenBudget: parseInt(process.env.AI_DAILY_TOKEN_BUDGET ?? "10000000", 10),
    aiMaxInputChars: parseInt(process.env.AI_MAX_INPUT_CHARS ?? "0", 10),
    aiEnableUwu: (process.env.ENABLE_UWU ?? "true").toLowerCase() !== "false",
    aiContextMaxMessages: Math.min(100, positiveInteger(process.env.AI_CONTEXT_MAX_MESSAGES, 40)),
    aiContextInactivityMinutes: positiveInteger(process.env.AI_CONTEXT_INACTIVITY_MINUTES, 20),

    openaiAdminKey: process.env.OPENAI_ADMIN_KEY?.trim() || undefined,
    usageOpenaiProjectId: process.env.USAGE_OPENAI_PROJECT_ID?.trim() || undefined,

    // Web Search
    webSearchEnabled: webSearchEnabled,
    webSearchApiKey: webSearchApiKey,
    webSearchMaxResults: parseInt(process.env.WEB_SEARCH_MAX_RESULTS ?? "3", 10),

    // Link Open
    linkOpenEnabled: linkOpenEnabled,

    discordActionsEnabled: (process.env.DISCORD_ACTIONS_ENABLED ?? "true").toLowerCase() === "true",
    discordActionsGuildIds: (process.env.DISCORD_ACTIONS_GUILD_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),

    // Autonomous Chat
    autonomousChatEnabled:
      (process.env.AUTONOMOUS_CHAT_ENABLED ?? "false").toLowerCase() === "true",
    autonomousChatChannelIds: [...new Set(autonomousChatChannelIds)],
    autonomousChatMinHumanMessages: parseInt(
      process.env.AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES ?? "4",
      10,
    ),
    autonomousChatActivityWindowMinutes: parseInt(
      process.env.AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES ?? "20",
      10,
    ),
    autonomousChatCooldownMinutes: parseInt(
      process.env.AUTONOMOUS_CHAT_COOLDOWN_MINUTES ?? "1",
      10,
    ),
    autonomousChatReplyChance: Math.min(1, Math.max(0, autonomousChatReplyChance)),
    autonomousChatSettleSeconds: 8,
    autonomousChatMaxContextMessages: parseInt(
      process.env.AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES ?? "40",
      10,
    ),
  };
}
