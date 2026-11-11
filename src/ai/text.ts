/** Reply text transforms: input truncation, reply sanitizing and the optional UwU style. */

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

export function uwuify(text: string, enabled: boolean): string {
  if (!enabled) return text;

  let out = text;
  out = out.replace(/!+/g, "!~");
  out = out.replace(/\?+/g, "?~");

  const hasEmojiOrUwu = /\p{Emoji}/u.test(out) || /uwu|owo|UwU/i.test(out);
  if (out.length <= 80 && !hasEmojiOrUwu) {
    out = out + " uwu";
  }

  return out;
}

export function sanitizeReply(raw: string): string {
  let sanitized = raw
    .replace(/\b(I(')?m sorry|I cannot|I can't|I couldn't|unable to)\b/gi, "")
    .trim();

  sanitized = sanitized
    .replace(/^(?:hey(?: there)?|hello(?: there)?|hi(?: there)?|yo|greetings)[,!.\s-]*/i, "")
    .trim();

  return sanitized;
}
