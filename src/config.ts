import fileConfig from "../config.yaml";
import { validateConfigFile } from "./config_schema.ts";
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
    /** Chance in [0, 1] that a message is a landmine. */
    chance: number;
    /** What happens to whoever steps on a landmine: a Discord timeout, if enabled. */
    stepPenalty: { enabled: boolean; timeoutSeconds: number };
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
  };
  ai_chat?: ReactiveFeatureFile;
  /** Also holds one section per provider, named for it; each provider's module defines its keys. */
  ai?: {
    enabled?: boolean;
    provider?: string;
    uwu?: boolean;
    rate_limit_per_user?: number;
    max_input_chars?: number;
    context?: { max_messages?: number; inactivity_minutes?: number };
    budget?: { daily_tokens?: number; daily_request_quota?: number; mention_percent?: number };
  };
  web_search?: ReactiveFeatureFile & { max_results?: number };
  link_open?: ReactiveFeatureFile;
  tweet_read?: ReactiveFeatureFile;
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
    chance?: number;
    gifs?: string[];
    step_penalty?: { enabled?: boolean; timeout_seconds?: number };
  };
}

/** A secret from the environment (.env); blank means unset. */
const secret = (name: string) => process.env[name] || undefined;

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
    aiContextInactivityMinutes: ai?.context?.inactivity_minutes ?? 20,

    webSearch: {
      ...reactiveFeature("web_search", search, Boolean(webSearchApiKey)),
      apiKey: webSearchApiKey,
      maxResults: search?.max_results ?? 3,
    },
    linkOpen: reactiveFeature("link_open", open),
    tweetRead: reactiveFeature("tweet_read", tweet),
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
      maxContextMessages: auto?.max_context_messages ?? 40,
      requestPercent: auto?.request_percent ?? 30,
    },

    landmine: {
      ...reactiveFeature("landmine", mine, false),
      chance: mine?.chance ?? 0.1,
      stepPenalty: {
        enabled: mine?.step_penalty?.enabled ?? true,
        // Discord allows timeouts of up to 28 days.
        timeoutSeconds: Math.min(mine?.step_penalty?.timeout_seconds ?? 60, 28 * 86_400),
      },
      gifs: mine?.gifs ?? [],
    },
  };
}
