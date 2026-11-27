import fileConfig from "../config.yaml";
import { validateConfigFile } from "./config_schema.ts";
import { LOG_LEVELS, type LogLevel } from "./app/log.ts";
import { AI_PROVIDERS } from "./ai/providers/index.ts";
import { DEFAULT_DATABASE_PATH } from "./db/database.ts";
import {
  parseChannelList,
  parseChannelScope,
  parseIds,
  type FeatureConfig,
} from "./feature_config.ts";

/**
 * Settings from config.yaml, plus the secrets in the environment (.env). A missing required
 * value fails at startup.
 */
export interface AppConfig {
  discordToken: string;
  /** HTTP administration is disabled unless this bearer token is set. */
  adminHttpToken?: string;
  channelIds: string[];
  databasePath: string;
  httpPort: number;
  logLevel: LogLevel;
  timeZone: string;

  /** Master switch for AI: false turns off mention replies, autonomous chat and event tools. */
  aiEnabled: boolean;
  /** Replies to mentions. It cannot turn on what `aiEnabled` turns off. */
  aiChat: FeatureConfig;
  /** A key of the provider registry (src/ai/providers/index.ts); unset only when AI is off. */
  aiProvider?: string;
  /** The provider's checked `ai.<provider>` settings; its own module knows the shape. */
  aiProviderSettings?: unknown;
  /** The provider's key from `.env`, and the name it was read from. */
  aiApiKey: string | undefined;
  aiApiKeyEnv?: string;
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
  aiContextMaxImages: number;
  aiContextInactivityMinutes: number;

  /** Searches the web for a mention. On by default when BRAVE_SEARCH_API_KEY is set. */
  webSearch: FeatureConfig & {
    apiKey: string | undefined;
    maxResults: number;
  };
  /** The \open link command. */
  linkOpen: FeatureConfig;
  /** Reading tweet links in mentions. */
  tweetRead: FeatureConfig;
  /** The \gacha command. */
  gacha: FeatureConfig & {
    /** Seconds a user waits between pulls. */
    cooldownSeconds: number;
    /** Seconds before a render is given up on. */
    timeoutSeconds: number;
    /** Pulls that may wait or draw at once; more are refused as busy. */
    queueSize: number;
  };
  /** The \rng command. */
  rng: FeatureConfig & {
    /** How many digits a number has. */
    digits: number;
    /** Seconds between the digits of a reveal; 0 shows the whole number at once. */
    digitDelaySeconds: number;
  };
  /** The event and invite tools. */
  discordActions: FeatureConfig & {
    /** Servers allowed to use the tools; empty allows all. */
    guildIds: string[];
  };

  /** The daily mood poll, which also collects the votes the stats and wellness alerts read. */
  moodPoll: FeatureConfig<string[]>;
  /** The daily check for users who keep voting "glue". It reads the mood poll's votes. */
  wellness: FeatureConfig<string[]> & {
    /** Consecutive "glue" days that trigger an alert. */
    glueAlertThreshold: number;
  };
  /** The weekly mood summary. It reads the mood poll's votes. */
  weeklyStats: FeatureConfig<string[]>;

  autonomousChat: FeatureConfig<string[]> & {
    minHumanMessages: number;
    activityWindowMinutes: number;
    cooldownMinutes: number;
    /** Chance in [0, 1] of joining when the channel is eligible. */
    replyChance: number;
    maxContextMessages: number;
    /** Share of the daily request quota, in percent, below which autonomous chat may run. */
    requestPercent: number;
    /** Wait for a burst of human messages to finish before reading it. */
    settleSeconds?: number;
  };

  landmine: FeatureConfig & {
    /** Where the weekly and monthly leaderboards are posted: a list, never "all". */
    reportChannelIds: string[];
    /** Chance in [0, 1] that a message is a landmine. */
    chance: number;
    /** What happens to whoever steps on a landmine: a Discord timeout, if enabled. */
    stepPenalty: { enabled: boolean; timeoutSeconds: number };
    /** Whether messages from bots, Haru included, can be landmines too. */
    includeBots: boolean;
    /** GIF links; the announcement ends with one picked at random. Empty means no GIF. */
    gifs: string[];
  };
}

/** The settings of a feature that posts to named channels. */
interface FeatureFile {
  enabled?: boolean;
  channel_ids?: string[];
}

/** The settings of a feature that reacts to messages, so it may work in "all" channels. */
interface ReactiveFeatureFile {
  enabled?: boolean;
  channel_ids?: string[] | "all";
}

/** The shape of config.yaml. Every key is optional; config.example.yaml documents them. */
export interface ConfigFile {
  discord?: {
    channel_ids?: string[];
  };
  general?: {
    time_zone?: string;
    db_path?: string;
    http_port?: number;
    log_level?: string;
  };
  ai_chat?: ReactiveFeatureFile;
  /** Also holds one section per provider, named for it; each provider's module defines its keys. */
  ai?: {
    enabled?: boolean;
    provider?: string;
    uwu?: boolean;
    rate_limit_per_user?: number;
    max_input_chars?: number;
    context?: { max_messages?: number; max_images?: number; inactivity_minutes?: number };
    budget?: { daily_tokens?: number; daily_request_quota?: number; mention_percent?: number };
  };
  web_search?: ReactiveFeatureFile & { max_results?: number };
  link_open?: ReactiveFeatureFile;
  tweet_read?: ReactiveFeatureFile;
  gacha?: ReactiveFeatureFile & {
    cooldown_seconds?: number;
    timeout_seconds?: number;
    queue_size?: number;
  };
  rng?: ReactiveFeatureFile & { digits?: number; digit_delay_seconds?: number };
  discord_actions?: ReactiveFeatureFile & { guild_ids?: string[] };
  mood_poll?: FeatureFile;
  wellness?: FeatureFile & { glue_alert_threshold?: number };
  weekly_stats?: FeatureFile;
  autonomous_chat?: FeatureFile & {
    reply_chance?: number;
    min_human_messages?: number;
    activity_window_minutes?: number;
    cooldown_minutes?: number;
    max_context_messages?: number;
    request_percent?: number;
  };
  landmine?: ReactiveFeatureFile & {
    report_channel_ids?: string[];
    chance?: number;
    include_bots?: boolean;
    gifs?: string[];
    step_penalty?: { enabled?: boolean; timeout_seconds?: number };
  };
}

/** A secret from the environment (.env); blank means unset. */
const secret = (name: string) => process.env[name] || undefined;

/** A setting that must be above zero; a missing one uses `fallback`. */
function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !(value > 0)) {
    throw new Error(`FATAL: ${name} in config.yaml must be a number above 0`);
  }
  return value;
}

/** `rng.digits`: a whole number from 1 to 12; a missing one is 6. */
function parseRngDigits(value: number | undefined): number {
  if (value === undefined) return 6;
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error("FATAL: rng.digits in config.yaml must be a whole number from 1 to 12");
  }
  return value;
}

/** `rng.digit_delay_seconds`: from 0 to 10, so a reveal cannot hang; a missing one is 1. */
function parseDigitDelay(value: number | undefined): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !(value >= 0 && value <= 10)) {
    throw new Error("FATAL: rng.digit_delay_seconds in config.yaml must be a number from 0 to 10");
  }
  return value;
}

/** `general.log_level`; a missing one is `info`. */
function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return "info";
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(
      `FATAL: general.log_level in config.yaml must be one of: ${LOG_LEVELS.join(", ")}`,
    );
  }
  return value as LogLevel;
}

/** Builds the app config from config.yaml (`file`, which tests replace) and the secrets in .env. */
export function loadConfig(file: ConfigFile = fileConfig): AppConfig {
  validateConfigFile(file);
  const { discord, general, ai, autonomous_chat: auto, landmine: mine } = file;
  const {
    ai_chat: aiChat,
    web_search: search,
    link_open: open,
    tweet_read: tweet,
    discord_actions: actions,
    gacha,
    rng,
  } = file;
  const { mood_poll: poll, wellness: care, weekly_stats: weekly } = file;

  const channelIds = parseIds("discord.channel_ids", discord?.channel_ids);
  if (channelIds.length === 0) {
    throw new Error("FATAL: Missing channel: set discord.channel_ids in config.yaml");
  }
  const discordToken = secret("DISCORD_TOKEN");
  if (!discordToken) throw new Error("FATAL: Missing required environment variable: DISCORD_TOKEN");

  // No provider is assumed: with AI on, one must be named. A provider that is named is checked
  // even with AI off, so switching AI on later cannot fail at startup.
  const aiEnabled = ai?.enabled ?? true;
  const aiProvider = ai?.provider || undefined;
  const known = Object.keys(AI_PROVIDERS).join(", ");
  if (!aiProvider && aiEnabled) {
    throw new Error(`FATAL: ai.provider is required in config.yaml (one of: ${known})`);
  }
  const providerModule =
    aiProvider && Object.hasOwn(AI_PROVIDERS, aiProvider) ? AI_PROVIDERS[aiProvider] : undefined;
  if (aiProvider && !providerModule) {
    throw new Error(`FATAL: Unknown ai.provider: ${aiProvider} (known: ${known})`);
  }
  const providerSection = aiProvider
    ? (ai as Record<string, unknown> | undefined)?.[aiProvider]
    : undefined;

  // A feature that posts to named channels, and one that reacts to messages and may use "all".
  const feature = (name: string, section: FeatureFile | undefined, on = true) => ({
    enabled: section?.enabled ?? on,
    channelIds: parseChannelList(`${name}.channel_ids`, section?.channel_ids, channelIds),
  });
  const reactiveFeature = (name: string, section: ReactiveFeatureFile | undefined, on = true) => ({
    enabled: section?.enabled ?? on,
    channelIds: parseChannelScope(`${name}.channel_ids`, section?.channel_ids, channelIds),
  });

  const webSearchApiKey = secret("BRAVE_SEARCH_API_KEY");

  return {
    discordToken,
    adminHttpToken: secret("ADMIN_HTTP_TOKEN"),
    channelIds,
    databasePath: general?.db_path ?? DEFAULT_DATABASE_PATH,
    httpPort: general?.http_port ?? 8000,
    logLevel: parseLogLevel(general?.log_level),
    timeZone: general?.time_zone ?? "America/Los_Angeles",

    aiEnabled,
    aiChat: reactiveFeature("ai_chat", aiChat),
    aiProvider,
    aiProviderSettings: providerModule?.parseConfig(providerSection, secret),
    aiApiKey: providerModule && secret(providerModule.apiKeyEnv),
    aiApiKeyEnv: providerModule?.apiKeyEnv,
    aiRateLimitPerUser: ai?.rate_limit_per_user ?? 2,
    aiDailyTokenBudget: ai?.budget?.daily_tokens ?? 10_000_000,
    aiDailyRequestQuota: ai?.budget?.daily_request_quota ?? undefined,
    aiDailyRequestPercent: ai?.budget?.mention_percent ?? 90,
    aiMaxInputChars: ai?.max_input_chars ?? 0,
    aiEnableUwu: ai?.uwu ?? true,
    aiContextMaxMessages: Math.min(ai?.context?.max_messages ?? 40, 100),
    aiContextMaxImages: ai?.context?.max_images ?? 4,
    aiContextInactivityMinutes: ai?.context?.inactivity_minutes ?? 20,

    webSearch: {
      ...reactiveFeature("web_search", search, Boolean(webSearchApiKey)),
      apiKey: webSearchApiKey,
      maxResults: search?.max_results ?? 3,
    },
    linkOpen: reactiveFeature("link_open", open),
    tweetRead: reactiveFeature("tweet_read", tweet),
    gacha: {
      ...reactiveFeature("gacha", gacha),
      cooldownSeconds: positive("gacha.cooldown_seconds", gacha?.cooldown_seconds, 10),
      timeoutSeconds: positive("gacha.timeout_seconds", gacha?.timeout_seconds, 30),
      queueSize: positive("gacha.queue_size", gacha?.queue_size, 8),
    },
    rng: {
      ...reactiveFeature("rng", rng),
      digits: parseRngDigits(rng?.digits),
      digitDelaySeconds: parseDigitDelay(rng?.digit_delay_seconds),
    },
    discordActions: {
      ...reactiveFeature("discord_actions", actions),
      guildIds: parseIds("discord_actions.guild_ids", actions?.guild_ids),
    },

    moodPoll: feature("mood_poll", poll),
    wellness: { ...feature("wellness", care), glueAlertThreshold: care?.glue_alert_threshold ?? 7 },
    weeklyStats: feature("weekly_stats", weekly),

    autonomousChat: {
      ...feature("autonomous_chat", auto, false),
      minHumanMessages: auto?.min_human_messages ?? 4,
      activityWindowMinutes: auto?.activity_window_minutes ?? 20,
      cooldownMinutes: auto?.cooldown_minutes ?? 1,
      replyChance: auto?.reply_chance ?? 0.35,
      settleSeconds: 8,
      maxContextMessages: auto?.max_context_messages ?? 20,
      requestPercent: auto?.request_percent ?? 30,
    },

    landmine: {
      ...reactiveFeature("landmine", mine, false),
      reportChannelIds: parseChannelList(
        "landmine.report_channel_ids",
        mine?.report_channel_ids,
        channelIds,
      ),
      chance: mine?.chance ?? 0.1,
      stepPenalty: {
        enabled: mine?.step_penalty?.enabled ?? true,
        // Discord allows timeouts of up to 28 days.
        timeoutSeconds: Math.min(mine?.step_penalty?.timeout_seconds ?? 60, 28 * 86_400),
      },
      includeBots: mine?.include_bots ?? false,
      gifs: mine?.gifs ?? [],
    },
  };
}
