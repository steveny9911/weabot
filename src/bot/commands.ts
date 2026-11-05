/** Parsing for mentions and the \\reset, \\open commands, plus reply text helpers. */
import type { LinkOpenError } from "../net/link_open.ts";

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/**
 * Returns true if the message mentions the bot.
 */
export function bMessageMentionsBot(message: Record<string, unknown>, bot_id: string): boolean {
  if (!message) return false;

  const mentions = message.mentions as unknown;
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (typeof mm.id === "string" && mm.id === bot_id) return true;
        if (typeof mm.username === "string" && mm.username === bot_id) return true;
      }
    }
  }

  // Fallback: check content for <@ID> or <@!ID>
  const content = message.content as unknown;
  if (typeof content === "string") {
    if (content.includes(`<@${bot_id}>`) || content.includes(`<@!${bot_id}>`)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the message includes the reset context command.
 * Expected format: "@Haru \\reset"
 */
export function bIsResetCommand(content: string | undefined): boolean {
  if (!content) return false;
  return /(^|\s)\\reset(\s|$)/i.test(content);
}

/**
 * Returns true if the message includes the open-link command.
 * Expected format: "@Haru \\open <url> [optional question]"
 */
export function bIsOpenCommand(content: string | undefined): boolean {
  if (!content) return false;
  const cleaned = content.replace(/<@!?\d+>/g, " ").trim();
  return /^\\open\b/i.test(cleaned);
}

export interface OpenCommand {
  url: string;
  userRequest?: string;
}

/**
 * Parses an open-link command.
 * Uses the first URL only and treats remaining text as optional user request.
 */
export function szParseOpenCommand(content: string | undefined): OpenCommand | null {
  if (!content) return null;
  const cleaned = content.replace(/<@!?\d+>/g, " ").trim();
  const match = cleaned.match(/^\\open\b\s+(.+)$/i);
  if (!match) return null;

  const tail = match[1].trim();
  if (!tail) return null;

  const first_url = tail.match(/https?:\/\/[^\s<>()]+/i);
  if (!first_url || first_url.index === undefined) return null;

  const url = first_url[0];
  const rest = tail.slice(first_url.index + url.length).trim();
  const user_request = rest.replace(URL_RE, "").replace(/\s+/g, " ").trim();

  return user_request ? { url, userRequest: user_request } : { url };
}

/**
 * Remove explicit URL tokens from model output.
 */
export function szStripUrls(text: string): string {
  return text
    .replace(URL_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export function szOpenFailureMessage(_error: LinkOpenError): string {
  return "Eep... I couldn't safely open that link. Can you try another one?~";
}

/**
 * Formats milliseconds into a human-readable string (seconds or minutes).
 */
export function szFormatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  const minutes = Math.ceil(ms / 60000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
