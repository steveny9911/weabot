/** Reply text transforms: input truncation, reply sanitizing and the optional UwU style. */

/**
 * Truncates a string to the specified max length, adding ellipsis if needed.
 */
export function vTruncateText(text: string, max_chars: number): string {
  if (text.length <= max_chars) return text;
  return text.slice(0, max_chars - 3) + "...";
}

/**
 * Applies light UwU-style text transformation if enabled.
 */
export function szUwuify(text: string, enabled: boolean): string {
  if (!enabled) return text;

  let out = text;
  // Soften punctuation with tildes
  out = out.replace(/!+/g, "!~");
  out = out.replace(/\?+/g, "?~");

  // For short replies without emoji/uwu, append a mild " uwu"
  const has_emoji_or_uwu = /\p{Emoji}/u.test(out) || /uwu|owo|UwU/i.test(out);
  if (out.length <= 80 && !has_emoji_or_uwu) {
    out = out + " uwu";
  }

  return out;
}

/**
 * Sanitizes the AI response text.
 */
export function szSanitizeReply(raw: string): string {
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
