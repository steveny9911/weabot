/** Parsing for mentions and the \\reset, \\open commands, plus reply text helpers. */
import type { LinkOpenError } from "../net/link_open.ts";

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

export function messageMentionsBot(message: Record<string, unknown>, botId: string): boolean {
  if (!message) return false;

  const mentions = message.mentions as unknown;
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (typeof mm.id === "string" && mm.id === botId) return true;
        if (typeof mm.username === "string" && mm.username === botId) return true;
      }
    }
  }

  const content = message.content as unknown;
  if (typeof content === "string") {
    if (content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`)) {
      return true;
    }
  }

  return false;
}

/** A `\\` command (`\\usage`, `\\open ...`, `\\reset`), with or without a leading mention. */
export function isCommand(content: string | undefined): boolean {
  if (!content) return false;
  return (
    content
      .replace(/<@!?\d+>/g, " ")
      .trim()
      .startsWith("\\") || isResetCommand(content)
  );
}

/** `@Haru \\reset` */
export function isResetCommand(content: string | undefined): boolean {
  if (!content) return false;
  return /(^|\s)\\reset(\s|$)/i.test(content);
}

/** `@Haru \\open <url> [question]` */
export function isOpenCommand(content: string | undefined): boolean {
  if (!content) return false;
  const cleaned = content.replace(/<@!?\d+>/g, " ").trim();
  return /^\\open\b/i.test(cleaned);
}

export interface OpenCommand {
  url: string;
  userRequest?: string;
}

/** Uses the first URL; the remaining text is the optional user request. */
export function parseOpenCommand(content: string | undefined): OpenCommand | null {
  if (!content) return null;
  const cleaned = content.replace(/<@!?\d+>/g, " ").trim();
  const match = cleaned.match(/^\\open\b\s+(.+)$/i);
  if (!match) return null;

  const tail = match[1].trim();
  if (!tail) return null;

  const firstUrl = tail.match(/https?:\/\/[^\s<>()]+/i);
  if (!firstUrl || firstUrl.index === undefined) return null;

  const url = firstUrl[0];
  const rest = tail.slice(firstUrl.index + url.length).trim();
  const userRequest = rest.replace(URL_RE, "").replace(/\s+/g, " ").trim();

  return userRequest ? { url, userRequest: userRequest } : { url };
}

export function stripUrls(text: string): string {
  return text
    .replace(URL_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export function openFailureMessage(_error: LinkOpenError): string {
  return "Eep... I couldn't safely open that link. Can you try another one?~";
}

export function formatTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  const minutes = Math.ceil(ms / 60000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
