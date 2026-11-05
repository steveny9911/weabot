/** Image URLs from conversation context (and replied-to messages) sent to the model. */

export const MAX_CONTEXT_IMAGES = 6;

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function getImageUrlsFromContextMessage(message: Record<string, unknown>): string[] {
  const rawUrls = message["imageUrls"] ?? message["images"];
  if (!Array.isArray(rawUrls)) return [];

  const urls: string[] = [];
  for (const rawUrl of rawUrls) {
    if (typeof rawUrl !== "string") continue;
    const trimmed = rawUrl.trim();
    if (!trimmed || !isHttpUrl(trimmed)) continue;
    urls.push(trimmed);
  }
  return urls;
}

export function getReplyReference(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  const reference = message["repliedTo"];
  return reference && typeof reference === "object" ? (reference as Record<string, unknown>) : null;
}

export function collectImageUrls(
  messages: Array<Record<string, unknown>>,
  maxImages: number,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const message of messages) {
    const reference = getReplyReference(message);
    const candidates = [
      ...getImageUrlsFromContextMessage(message),
      ...(reference ? getImageUrlsFromContextMessage(reference) : []),
    ];
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= maxImages) {
        return urls;
      }
    }
  }

  return urls;
}
