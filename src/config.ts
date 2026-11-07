export const AI_PROVIDER_NAMES = ["openai", "gemini"] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

/** Configuration read from environment variables. Missing required values fail at startup. */
export interface AppConfig {
  discordToken: string;
  /** HTTP administration is disabled unless this bearer token is set. */
  adminHttpToken?: string;
  channelId: string;
  channelIds: string[];
  timeZone: string;
  /** Consecutive "glue" days that trigger a wellness alert. */
  glueAlertThreshold: number;

  aiEnabled: boolean;
  aiProvider: AiProviderName;
  aiApiKey: string | undefined;
  /** Model name for providers that have no saved prompt. */
  aiModel?: string;
  /** File holding the persona for providers that have no saved prompt. */
  aiSystemPromptFile?: string;
  /** Lets Gemini models think before answering; off asks for their lowest thinking level. */
  aiThinking: boolean;
  /** AI requests per user per minute. */
  aiRateLimitPerUser: number;
  /** Soft daily token threshold; requests already in flight may exceed it. */
  aiDailyTokenBudget: number;
  /** Provider model calls allowed per Pacific day; unset means unlimited. */
  aiDailyRequestQuota?: number;
  /** Share of the quota, in percent, that mentions may use. */
  aiDailyRequestPercent: number;
  /** Max characters per input message; 0 disables truncation. */
  aiMaxInputChars: number;
  aiEnableUwu: boolean;
  aiContextMaxMessages: number;
  /** Minutes of silence that start a new conversation context. */
  aiContextInactivityMinutes: number;

  /** Organization admin key for usage reads; separate from the chat key. */
  openaiAdminKey?: string;
  usageOpenaiProjectId?: string;

  webSearchEnabled: boolean;
  webSearchApiKey: string | undefined;
  webSearchMaxResults: number;
  linkOpenEnabled: boolean;

  discordActionsEnabled?: boolean;
  /** Servers allowed to use event/invite actions; empty allows all. */
  discordActionsGuildIds?: string[];

  autonomousChatEnabled: boolean;
  autonomousChatChannelIds: string[];
  autonomousChatMinHumanMessages: number;
  autonomousChatActivityWindowMinutes: number;
  autonomousChatCooldownMinutes: number;
  /** Chance in [0, 1] of joining when the channel is eligible. */
  autonomousChatReplyChance: number;
  autonomousChatMaxContextMessages: number;
  /** Share of the daily request quota, in percent, below which autonomous chat may run. */
  autonomousChatRequestPercent: number;
  /** Wait for a burst of human messages to finish before reading it. */
  autonomousChatSettleSeconds?: number;
}

const env = process.env;
const notFalse = (key: string, fallback = "true") =>
  (env[key] ?? fallback).toLowerCase() !== "false";
const isTrue = (key: string, fallback = "false") => (env[key] ?? fallback).toLowerCase() === "true";
const int = (key: string, fallback: number) => parseInt(env[key] ?? String(fallback), 10);
const optional = (key: string) => env[key]?.trim() || undefined;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

function positiveInteger(key: string, fallback: number): number {
  const parsed = parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percent(key: string, fallback: number): number {
  const parsed = parseInt(env[key] ?? "", 10);
  return parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const listed = list(env.CHANNEL_IDS);
  if (env.CHANNEL_ID && !listed.includes(env.CHANNEL_ID)) listed.push(env.CHANNEL_ID);
  if (listed.length === 0) {
    throw new Error("FATAL: Missing required environment variable: CHANNEL_ID or CHANNEL_IDS");
  }
  const channelIds = [...new Set(listed)];
  const discordToken = env.DISCORD_TOKEN;
  if (!discordToken) throw new Error("FATAL: Missing required environment variable: DISCORD_TOKEN");

  const aiProvider = env.AI_PROVIDER?.trim().toLowerCase() || "openai";
  if (!AI_PROVIDER_NAMES.includes(aiProvider as AiProviderName)) {
    throw new Error(`FATAL: Unknown AI_PROVIDER: ${aiProvider}`);
  }

  const webSearchApiKey = env.BRAVE_SEARCH_API_KEY;
  const replyChance = parseFloat(env.AUTONOMOUS_CHAT_REPLY_CHANCE ?? "0.35");

  return {
    discordToken,
    adminHttpToken: optional("ADMIN_HTTP_TOKEN"),
    channelId: channelIds[0],
    channelIds,
    timeZone: env.TIME_ZONE ?? "America/Los_Angeles",
    glueAlertThreshold: int("GLUE_ALERT_THRESHOLD", 7),

    aiEnabled: notFalse("AI_ENABLED"),
    aiProvider: aiProvider as AiProviderName,
    // OPENAI_API_KEY is the original name, still accepted for OpenAI.
    aiApiKey: optional("AI_API_KEY") ?? (aiProvider === "openai" ? env.OPENAI_API_KEY : undefined),
    aiModel: optional("AI_MODEL"),
    aiSystemPromptFile: optional("AI_SYSTEM_PROMPT_FILE"),
    aiThinking: isTrue("AI_THINKING"),
    aiRateLimitPerUser: int("AI_RATE_LIMIT_PER_USER", 2),
    aiDailyTokenBudget: int("AI_DAILY_TOKEN_BUDGET", 10_000_000),
    aiDailyRequestQuota: positiveInteger("AI_DAILY_REQUEST_QUOTA", 0) || undefined,
    aiDailyRequestPercent: percent("AI_DAILY_REQUEST_PERCENT", 90),
    aiMaxInputChars: int("AI_MAX_INPUT_CHARS", 0),
    aiEnableUwu: notFalse("ENABLE_UWU"),
    aiContextMaxMessages: Math.min(100, positiveInteger("AI_CONTEXT_MAX_MESSAGES", 40)),
    aiContextInactivityMinutes: positiveInteger("AI_CONTEXT_INACTIVITY_MINUTES", 20),

    openaiAdminKey: optional("OPENAI_ADMIN_KEY"),
    usageOpenaiProjectId: optional("USAGE_OPENAI_PROJECT_ID"),

    webSearchEnabled: notFalse("WEB_SEARCH_ENABLED", webSearchApiKey ? "true" : "false"),
    webSearchApiKey,
    webSearchMaxResults: int("WEB_SEARCH_MAX_RESULTS", 3),
    linkOpenEnabled: notFalse("LINK_OPEN_ENABLED"),

    discordActionsEnabled: isTrue("DISCORD_ACTIONS_ENABLED", "true"),
    discordActionsGuildIds: list(env.DISCORD_ACTIONS_GUILD_IDS),

    autonomousChatEnabled: isTrue("AUTONOMOUS_CHAT_ENABLED"),
    autonomousChatChannelIds: [
      ...new Set(
        env.AUTONOMOUS_CHAT_CHANNEL_IDS ? list(env.AUTONOMOUS_CHAT_CHANNEL_IDS) : channelIds,
      ),
    ],
    autonomousChatMinHumanMessages: int("AUTONOMOUS_CHAT_MIN_HUMAN_MESSAGES", 4),
    autonomousChatActivityWindowMinutes: int("AUTONOMOUS_CHAT_ACTIVITY_WINDOW_MINUTES", 20),
    autonomousChatCooldownMinutes: int("AUTONOMOUS_CHAT_COOLDOWN_MINUTES", 1),
    autonomousChatReplyChance: Math.min(
      1,
      Math.max(0, Number.isFinite(replyChance) ? replyChance : 0.35),
    ),
    autonomousChatSettleSeconds: 8,
    autonomousChatMaxContextMessages: int("AUTONOMOUS_CHAT_MAX_CONTEXT_MESSAGES", 40),
    autonomousChatRequestPercent: percent("AUTONOMOUS_CHAT_REQUEST_PERCENT", 30),
  };
}
