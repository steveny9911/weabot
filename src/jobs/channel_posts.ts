/** Shared shape for jobs that post to every configured channel. */
import type { AppConfig } from "../config.ts";
import type { DiscordClient } from "../services/discord.ts";
import type { StorageService } from "../services/storage.ts";

export interface JobDeps {
  config: AppConfig;
  discord: DiscordClient;
  storage: StorageService;
}

/** Log prefix of the caller: scheduled jobs log as [CRON], admin routes as [SERVER]. */
export type LogTag = "[CRON]" | "[SERVER]";

/** One channel's result. `detail` is the new message ID on success, Discord's error body otherwise. */
export interface ChannelPost {
  channelId: string;
  ok: boolean;
  detail: string;
}
