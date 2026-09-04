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

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?)$/i;

function bIsHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function bAttachmentLooksLikeImage(attachment: Record<string, unknown>): boolean {
  const content_type = attachment["content_type"];
  if (typeof content_type === "string" && content_type.startsWith("image/")) return true;

  const filename = attachment["filename"];
  if (typeof filename === "string" && IMAGE_FILE_EXT_RE.test(filename)) return true;

  const width = attachment["width"];
  const height = attachment["height"];
  return typeof width === "number" && width > 0 && typeof height === "number" && height > 0;
}

function aszExtractImageUrls(message: Record<string, unknown>): string[] {
  const attachments = message["attachments"];
  if (!Array.isArray(attachments)) return [];

  const image_urls: string[] = [];
  for (const raw_attachment of attachments) {
    if (!raw_attachment || typeof raw_attachment !== "object") continue;

    const attachment = raw_attachment as Record<string, unknown>;
    if (!bAttachmentLooksLikeImage(attachment)) continue;

    const candidate = typeof attachment["url"] === "string"
      ? attachment["url"]
      : (typeof attachment["proxy_url"] === "string" ? attachment["proxy_url"] : undefined);
    if (!candidate) continue;

    const trimmed = candidate.trim();
    if (trimmed && bIsHttpUrl(trimmed)) image_urls.push(trimmed);
  }

  return [...new Set(image_urls)];
}

function szAuthorName(author: Record<string, unknown>): string {
  const global_name = author["global_name"];
  if (typeof global_name === "string" && global_name.trim()) return global_name;

  const username = author["username"];
  if (typeof username === "string" && username.trim()) return username;

  const id = author["id"];
  return typeof id === "string" && id.trim() ? id : "unknown";
}

function oMapReference(message: Record<string, unknown>): DiscordMessageReference {
  const author = message["author"] && typeof message["author"] === "object"
    ? message["author"] as Record<string, unknown>
    : {};

  return {
    id: typeof message["id"] === "string" ? message["id"] : "",
    authorId: typeof author["id"] === "string" ? author["id"] : "",
    authorName: szAuthorName(author),
    content: typeof message["content"] === "string" ? message["content"] : "",
    timestamp: typeof message["timestamp"] === "string"
      ? message["timestamp"]
      : (typeof message["created_at"] === "string" ? message["created_at"] : ""),
    imageUrls: aszExtractImageUrls(message),
  };
}

export function oMapDiscordMessage(message: Record<string, unknown>): RecentDiscordMessage {
  const author = message["author"] && typeof message["author"] === "object"
    ? message["author"] as Record<string, unknown>
    : {};
  const referenced = message["referenced_message"];
  const referenced_message = referenced && typeof referenced === "object"
    ? oMapReference(referenced as Record<string, unknown>)
    : undefined;

  return {
    ...oMapReference(message),
    authorBot: author["bot"] === true,
    ...(referenced_message ? { referencedMessage: referenced_message } : {}),
  };
}

function nTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function bHasConversationContent(message: RecentDiscordMessage): boolean {
  return message.content.trim().length > 0 || message.imageUrls.length > 0;
}

/** Selects only the newest uninterrupted conversation, oldest message first. */
export function selectActiveConversation(
  messages: RecentDiscordMessage[],
  options: ChatContextOptions,
): RecentDiscordMessage[] {
  const reset_after_ms = options.resetAfterMs ?? null;
  const timestamped: TimestampedMessage[] = messages
    .map((message, index) => {
      const timestamp_ms = nTimestampMs(message.timestamp);
      if (timestamp_ms === null) return null;
      return { message, timestampMs: timestamp_ms, index };
    })
    .filter((item): item is TimestampedMessage => item !== null)
    .filter(({ message }) => bHasConversationContent(message))
    .filter(({ timestampMs }) => reset_after_ms === null || timestampMs > reset_after_ms)
    .sort((a, b) => a.timestampMs - b.timestampMs || a.index - b.index);

  if (timestamped.length === 0) return [];

  const inactivity_gap_ms = Math.max(0, options.inactivityGapMs);
  let session_start = timestamped.length - 1;
  for (let index = timestamped.length - 2; index >= 0; index--) {
    const gap_ms = timestamped[index + 1].timestampMs - timestamped[index].timestampMs;
    if (gap_ms > inactivity_gap_ms) break;
    session_start = index;
  }

  const max_messages = Math.max(1, Math.trunc(options.maxMessages));
  return timestamped.slice(session_start).slice(-max_messages).map(({ message }) => message);
}

function oReferenceForAi(reference: DiscordMessageReference): Record<string, unknown> {
  return {
    id: reference.id,
    author: reference.authorName || reference.authorId || "unknown",
    content: reference.content,
    imageUrls: reference.imageUrls,
    timestamp: reference.timestamp || null,
  };
}

export function oToAiContextMessage(message: RecentDiscordMessage): Record<string, unknown> {
  return {
    id: message.id,
    author: message.authorName || message.authorId || "unknown",
    content: message.content,
    imageUrls: message.imageUrls,
    timestamp: message.timestamp || null,
    ...(message.referencedMessage ? { repliedTo: oReferenceForAi(message.referencedMessage) } : {}),
  };
}
