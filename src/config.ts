import fileConfig from "../config.yaml";
import { DEFAULT_DATABASE_PATH } from "./db/database.ts";

export const AI_PROVIDER_NAMES = ["openai", "gemini"] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

/**
 * Settings from config.yaml, plus the secrets in the environment (.env). A missing required
 * value fails at startup.
 */
export interface AppConfig {
  discordToken: string;
  /** HTTP administration is disabled unless this bearer token is set. */
  adminHttpToken?: string;
  channelId: string;
  channelIds: string[];
  databasePath: string;
  httpPort: number;
  timeZone: string;
  /** Consecutive "glue" days that trigger a wellness alert. */
  glueAlertThreshold: number;

  aiEnabled: boolean;
  aiProvider: AiProviderName;
  aiApiKey: string | undefined;
  /** Models for providers that have no saved prompt, tried in order. */
  aiModels: string[];
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
  tweetReadEnabled: boolean;

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

  landmineEnabled: boolean;
  /** Channels with landmines: landmine.channel_ids, or the bot's channels when that is empty. */
  landmineChannelIds: string[];
  /** Chance in [0, 1] that a message is a landmine. */
  landmineChance: number;
  /** Whether stepping on a landmine also times the user out. */
  landmineTimeoutEnabled: boolean;
  landmineTimeoutSeconds: number;
  /** GIF links; the announcement ends with one picked at random. Empty means no GIF. */
  landmineGifs: string[];
}

/** The shape of config.yaml. Every key is optional; config.example.yaml documents them. */
export interface ConfigFile {
  discord?: {
    channel_ids?: string[];
    actions?: { enabled?: boolean; guild_ids?: string[] };
  };
  general?: {
    time_zone?: string;
    glue_alert_threshold?: number;
    db_path?: string;
    http_port?: number;
  };
  ai?: {
    enabled?: boolean;
    provider?: string;
    models?: string[];
    system_prompt_file?: string;
    thinking?: boolean;
    uwu?: boolean;
    rate_limit_per_user?: number;
    max_input_chars?: number;
    context?: { max_messages?: number; inactivity_minutes?: number };
    budget?: { daily_tokens?: number; daily_request_quota?: number; mention_percent?: number };
  };
  features?: {
    web_search?: { enabled?: boolean; max_results?: number };
    link_open?: boolean;
    tweet_read?: boolean;
  };
  usage?: { openai_project_id?: string };
  autonomous_chat?: {
    enabled?: boolean;
    channel_ids?: string[];
    reply_chance?: number;
    min_human_messages?: number;
    activity_window_minutes?: number;
    cooldown_minutes?: number;
    max_context_messages?: number;
    request_percent?: number;
  };
  landmine?: {
    enabled?: boolean;
    channel_ids?: string[];
    chance?: number;
    gifs?: string[];
    timeout?: { enabled?: boolean; seconds?: number };
  };
}

/** A secret from the environment (.env); blank means unset. */
const secret = (name: string) => process.env[name] || undefined;

/** Unique IDs. They must be quoted in YAML: unquoted, they parse as numbers and lose digits. */
function ids(name: string, value: unknown[] = []): string[] {
  if (value.some((id) => typeof id !== "string")) {
    throw new Error(`FATAL: ${name} in config.yaml must be a list of quoted strings`);
  }
  return [...new Set(value as string[])];
}

/** Builds the app config from config.yaml (`file`, which tests replace) and the secrets in .env. */
export function loadConfig(file: ConfigFile = fileConfig): AppConfig {
  const { discord, general, ai, features, usage, autonomous_chat: auto, landmine: mine } = file;

  const channelIds = ids("discord.channel_ids", discord?.channel_ids);
  if (channelIds.length === 0) {
    throw new Error("FATAL: Missing channel: set discord.channel_ids in config.yaml");
  }
  const discordToken = secret("DISCORD_TOKEN");
  if (!discordToken) throw new Error("FATAL: Missing required environment variable: DISCORD_TOKEN");

  const aiProvider = ai?.provider ?? "openai";
  if (!AI_PROVIDER_NAMES.includes(aiProvider as AiProviderName)) {
    throw new Error(`FATAL: Unknown ai.provider: ${aiProvider}`);
  }

  const webSearchApiKey = secret("BRAVE_SEARCH_API_KEY");
  const autonomousChannelIds = ids("autonomous_chat.channel_ids", auto?.channel_ids);
  const landmineChannelIds = ids("landmine.channel_ids", mine?.channel_ids);

  return {
    discordToken,
    adminHttpToken: secret("ADMIN_HTTP_TOKEN"),
    channelId: channelIds[0],
    channelIds,
    databasePath: general?.db_path ?? DEFAULT_DATABASE_PATH,
    httpPort: general?.http_port ?? 8000,
    timeZone: general?.time_zone ?? "America/Los_Angeles",
    glueAlertThreshold: general?.glue_alert_threshold ?? 7,

    aiEnabled: ai?.enabled ?? true,
    aiProvider: aiProvider as AiProviderName,
    // OPENAI_API_KEY is the original name, still accepted for OpenAI.
    aiApiKey:
      secret("AI_API_KEY") ?? (aiProvider === "openai" ? secret("OPENAI_API_KEY") : undefined),
    aiModels: [...new Set(ai?.models ?? [])],
    aiSystemPromptFile: ai?.system_prompt_file || undefined,
    aiThinking: ai?.thinking ?? false,
    aiRateLimitPerUser: ai?.rate_limit_per_user ?? 2,
    aiDailyTokenBudget: ai?.budget?.daily_tokens ?? 10_000_000,
    aiDailyRequestQuota: ai?.budget?.daily_request_quota ?? undefined,
    aiDailyRequestPercent: ai?.budget?.mention_percent ?? 90,
    aiMaxInputChars: ai?.max_input_chars ?? 0,
    aiEnableUwu: ai?.uwu ?? true,
    aiContextMaxMessages: Math.min(ai?.context?.max_messages ?? 40, 100),
    aiContextInactivityMinutes: ai?.context?.inactivity_minutes ?? 20,

    openaiAdminKey: secret("OPENAI_ADMIN_KEY"),
    usageOpenaiProjectId: usage?.openai_project_id || undefined,

    webSearchEnabled: features?.web_search?.enabled ?? Boolean(webSearchApiKey),
    webSearchApiKey,
    webSearchMaxResults: features?.web_search?.max_results ?? 3,
    linkOpenEnabled: features?.link_open ?? true,
    tweetReadEnabled: features?.tweet_read ?? true,

    discordActionsEnabled: discord?.actions?.enabled ?? true,
    discordActionsGuildIds: ids("discord.actions.guild_ids", discord?.actions?.guild_ids),

    autonomousChatEnabled: auto?.enabled ?? false,
    autonomousChatChannelIds: autonomousChannelIds.length ? autonomousChannelIds : channelIds,
    autonomousChatMinHumanMessages: auto?.min_human_messages ?? 4,
    autonomousChatActivityWindowMinutes: auto?.activity_window_minutes ?? 20,
    autonomousChatCooldownMinutes: auto?.cooldown_minutes ?? 1,
    autonomousChatReplyChance: auto?.reply_chance ?? 0.35,
    autonomousChatSettleSeconds: 8,
    autonomousChatMaxContextMessages: auto?.max_context_messages ?? 40,
    autonomousChatRequestPercent: auto?.request_percent ?? 30,

    landmineEnabled: mine?.enabled ?? false,
    landmineChannelIds: landmineChannelIds.length ? landmineChannelIds : channelIds,
    landmineChance: mine?.chance ?? 0.1,
    landmineTimeoutEnabled: mine?.timeout?.enabled ?? true,
    // Discord allows timeouts of up to 28 days.
    landmineTimeoutSeconds: Math.min(mine?.timeout?.seconds ?? 60, 28 * 86_400),
    landmineGifs: mine?.gifs ?? [],
  };
}
