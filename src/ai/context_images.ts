/** Image URLs from conversation context (and replied-to messages) sent to the model. */

export const MAX_CONTEXT_IMAGES = 6;

function bIsHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function aszGetImageUrlsFromContextMessage(message: Record<string, unknown>): string[] {
  const raw_urls = message["imageUrls"] ?? message["images"];
  if (!Array.isArray(raw_urls)) return [];

  const urls: string[] = [];
  for (const raw_url of raw_urls) {
    if (typeof raw_url !== "string") continue;
    const trimmed = raw_url.trim();
    if (!trimmed || !bIsHttpUrl(trimmed)) continue;
    urls.push(trimmed);
  }
  return urls;
}

export function oGetReplyReference(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  const reference = message["repliedTo"];
  return reference && typeof reference === "object" ? (reference as Record<string, unknown>) : null;
}

export function aszCollectImageUrls(
  messages: Array<Record<string, unknown>>,
  max_images: number,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const message of messages) {
    const reference = oGetReplyReference(message);
    const candidates = [
      ...aszGetImageUrlsFromContextMessage(message),
      ...(reference ? aszGetImageUrlsFromContextMessage(reference) : []),
    ];
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= max_images) {
        return urls;
      }
    }
  }

  return urls;
}
