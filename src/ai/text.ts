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

/** Drops a leading "hi", "hello there" etc.; a reply that is only a greeting stays as it is. */
export function sanitizeReply(raw: string): string {
  const greeting = /^(?:hey(?: there)?|hello(?: there)?|hi(?: there)?|yo|greetings)[,!.\s-]*/i;
  return raw.replace(greeting, "").trim() || raw;
}
