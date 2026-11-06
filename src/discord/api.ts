/**
 * Shared Discord REST settings. Each client keeps its own retry, timeout and redirect rules, so
 * this module holds only what they have in common.
 */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Bot authorization plus a JSON content type, as sent by every JSON request. */
export function botJsonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}
