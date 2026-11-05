/** Reply text transforms: input truncation, reply sanitizing and the optional UwU style. */

/**
 * Truncates a string to the specified max length, adding ellipsis if needed.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

/**
 * Applies light UwU-style text transformation if enabled.
 */
export function uwuify(text: string, enabled: boolean): string {
  if (!enabled) return text;

  let out = text;
  // Soften punctuation with tildes
  out = out.replace(/!+/g, "!~");
  out = out.replace(/\?+/g, "?~");

  // For short replies without emoji/uwu, append a mild " uwu"
  const hasEmojiOrUwu = /\p{Emoji}/u.test(out) || /uwu|owo|UwU/i.test(out);
  if (out.length <= 80 && !hasEmojiOrUwu) {
    out = out + " uwu";
  }

  return out;
}

/**
 * Sanitizes the AI response text.
 */
export function sanitizeReply(raw: string): string {
  // Remove apologetic/failure phrases
  let sanitized = raw
    .replace(/\b(I(')?m sorry|I cannot|I can't|I couldn't|unable to)\b/gi, "")
    .trim();

  // Remove generic leading greetings
  sanitized = sanitized
    .replace(/^(?:hey(?: there)?|hello(?: there)?|hi(?: there)?|yo|greetings)[,!.\s-]*/i, "")
    .trim();

  return sanitized;
}
