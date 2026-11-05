export interface DiscordMessageReference {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  imageUrls: string[];
}

export interface RecentDiscordMessage extends DiscordMessageReference {
  authorBot: boolean;
  /** Discord's reaction summary reports whether the current bot already reacted. */
  hasOwnReaction?: boolean;
  referencedMessage?: DiscordMessageReference;
}

export interface ChatContextOptions {
  maxMessages: number;
  inactivityGapMs: number;
  resetAfterMs?: number | null;
}

interface TimestampedMessage {
  message: RecentDiscordMessage;
  timestampMs: number;
  index: number;
}

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i;
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function attachmentLooksLikeImage(attachment: Record<string, unknown>): boolean {
  const rawContentType = attachment["content_type"];
  const contentType =
    typeof rawContentType === "string" ? rawContentType.split(";", 1)[0].trim().toLowerCase() : "";
  if (contentType && contentType !== "application/octet-stream") {
    return IMAGE_CONTENT_TYPES.has(contentType);
  }

  const filename = attachment["filename"];
  if (typeof filename === "string" && filename.trim()) {
    return IMAGE_FILE_EXT_RE.test(filename.trim());
  }

  // Videos also have width and height. Require an image format, not dimensions.
  const url = attachment["url"] ?? attachment["proxy_url"];
  if (typeof url !== "string" || !isHttpUrl(url)) return false;
  return IMAGE_FILE_EXT_RE.test(new URL(url).pathname);
}

function extractImageUrls(message: Record<string, unknown>): string[] {
  const attachments = message["attachments"];
  if (!Array.isArray(attachments)) return [];

  const imageUrls: string[] = [];
  for (const rawAttachment of attachments) {
    if (!rawAttachment || typeof rawAttachment !== "object") continue;

    const attachment = rawAttachment as Record<string, unknown>;
    if (!attachmentLooksLikeImage(attachment)) continue;

    const candidate =
      typeof attachment["url"] === "string"
        ? attachment["url"]
        : typeof attachment["proxy_url"] === "string"
          ? attachment["proxy_url"]
          : undefined;
    if (!candidate) continue;

    const trimmed = candidate.trim();
    if (trimmed && isHttpUrl(trimmed)) imageUrls.push(trimmed);
  }

  return [...new Set(imageUrls)];
}

function displayAuthorName(author: Record<string, unknown>): string {
  const globalName = author["global_name"];
  if (typeof globalName === "string" && globalName.trim()) return globalName;

  const username = author["username"];
  if (typeof username === "string" && username.trim()) return username;

  const id = author["id"];
  return typeof id === "string" && id.trim() ? id : "unknown";
}

function mapReference(message: Record<string, unknown>): DiscordMessageReference {
  const author =
    message["author"] && typeof message["author"] === "object"
      ? (message["author"] as Record<string, unknown>)
      : {};

  return {
    id: typeof message["id"] === "string" ? message["id"] : "",
    authorId: typeof author["id"] === "string" ? author["id"] : "",
    authorName: displayAuthorName(author),
    content: typeof message["content"] === "string" ? message["content"] : "",
    timestamp:
      typeof message["timestamp"] === "string"
        ? message["timestamp"]
        : typeof message["created_at"] === "string"
          ? message["created_at"]
          : "",
    imageUrls: extractImageUrls(message),
  };
}

export function mapDiscordMessage(message: Record<string, unknown>): RecentDiscordMessage {
  const author =
    message["author"] && typeof message["author"] === "object"
      ? (message["author"] as Record<string, unknown>)
      : {};
  const referenced = message["referenced_message"];
  const referencedMessage =
    referenced && typeof referenced === "object"
      ? mapReference(referenced as Record<string, unknown>)
      : undefined;

  return {
    ...mapReference(message),
    authorBot: author["bot"] === true || typeof message["webhook_id"] === "string",
    ...(Array.isArray(message["reactions"]) &&
    message["reactions"].some(
      (reaction) =>
        reaction !== null &&
        typeof reaction === "object" &&
        (reaction.me === true || reaction.me_burst === true),
    )
      ? { hasOwnReaction: true }
      : {}),
    ...(referencedMessage ? { referencedMessage: referencedMessage } : {}),
  };
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasConversationContent(message: RecentDiscordMessage): boolean {
  return message.content.trim().length > 0 || message.imageUrls.length > 0;
}

/** Selects only the newest uninterrupted conversation, oldest message first. */
export function selectActiveConversation(
  messages: RecentDiscordMessage[],
  options: ChatContextOptions,
): RecentDiscordMessage[] {
  const resetAfterMs = options.resetAfterMs ?? null;
  const timestamped: TimestampedMessage[] = messages
    .map((message, index) => {
      const timestampMs = parseTimestampMs(message.timestamp);
      if (timestampMs === null) return null;
      return { message, timestampMs: timestampMs, index };
    })
    .filter((item): item is TimestampedMessage => item !== null)
    .filter(({ message }) => hasConversationContent(message))
    .filter(({ timestampMs }) => resetAfterMs === null || timestampMs > resetAfterMs)
    .sort((a, b) => {
      const timeDifference = a.timestampMs - b.timestampMs;
      if (timeDifference !== 0) return timeDifference;
      // Discord returns newest first; snowflakes disambiguate millisecond ties.
      if (/^\d+$/.test(a.message.id) && /^\d+$/.test(b.message.id)) {
        const idA = BigInt(a.message.id);
        const idB = BigInt(b.message.id);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      }
      return a.index - b.index;
    });

  if (timestamped.length === 0) return [];

  const inactivityGapMs = Math.max(0, options.inactivityGapMs);
  let sessionStart = timestamped.length - 1;
  for (let index = timestamped.length - 2; index >= 0; index--) {
    const gapMs = timestamped[index + 1].timestampMs - timestamped[index].timestampMs;
    if (gapMs > inactivityGapMs) break;
    sessionStart = index;
  }

  const maxMessages = Math.max(1, Math.trunc(options.maxMessages));
  return timestamped
    .slice(sessionStart)
    .slice(-maxMessages)
    .map(({ message }) => message);
}

function referenceForAi(reference: DiscordMessageReference): Record<string, unknown> {
  return {
    id: reference.id,
    author: reference.authorName || reference.authorId || "unknown",
    content: reference.content,
    imageUrls: reference.imageUrls,
    timestamp: reference.timestamp || null,
  };
}

export function toAiContextMessage(message: RecentDiscordMessage): Record<string, unknown> {
  return {
    id: message.id,
    author: message.authorName || message.authorId || "unknown",
    content: message.content,
    imageUrls: message.imageUrls,
    timestamp: message.timestamp || null,
    ...(message.referencedMessage ? { repliedTo: referenceForAi(message.referencedMessage) } : {}),
  };
}
