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
  return {
    discordToken: getEnvOrThrow("DISCORD_TOKEN"),
    channelId: getEnvOrThrow("CHANNEL_ID"),
    timeZone: Deno.env.get("TIME_ZONE") ?? "America/Los_Angeles",
  };
}
