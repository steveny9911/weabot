export interface RecentDiscordMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorBot: boolean;
  content: string;
  timestamp: string;
  imageUrls: string[];
}

export interface AutonomousChatOptions {
  botUserId: string;
  nowMs: number;
  minHumanMessages: number;
  activityWindowMs: number;
  cooldownMs: number;
  maxContextMessages: number;
  replyChance: number;
  random: () => number;
}

export interface AutonomousChatDecision {
  shouldReply: boolean;
  reason: string;
  contextMessages: Array<Record<string, unknown>>;
}

interface TimestampedRecentMessage {
  message: RecentDiscordMessage;
  timestampMs: number;
  index: number;
}

function nTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function bHasConversationContent(message: RecentDiscordMessage): boolean {
  return message.content.trim().length > 0 || message.imageUrls.length > 0;
}

function bIsHumanMessage(message: RecentDiscordMessage, botUserId: string): boolean {
  return !message.authorBot && message.authorId !== botUserId;
}

function oToAiContextMessage(message: RecentDiscordMessage): Record<string, unknown> {
  return {
    id: message.id,
    author: message.authorName || message.authorId || "unknown",
    content: message.content,
    imageUrls: message.imageUrls,
    timestamp: message.timestamp,
  };
}

export function decideAutonomousChatReply(
  messages: RecentDiscordMessage[],
  options: AutonomousChatOptions,
): AutonomousChatDecision {
  const timestamped: TimestampedRecentMessage[] = messages
    .map((message, index) => {
      const timestamp_ms = nTimestampMs(message.timestamp);
      if (timestamp_ms === null) return null;
      return { message, timestampMs: timestamp_ms, index };
    })
    .filter((item): item is TimestampedRecentMessage => item !== null)
    .filter(({ message }) => bHasConversationContent(message))
    .sort((a, b) => a.timestampMs - b.timestampMs || a.index - b.index);

  if (timestamped.length === 0) {
    return { shouldReply: false, reason: "no valid recent messages", contextMessages: [] };
  }

  const min_human_messages = Math.max(1, options.minHumanMessages);
  const recent_human_messages = timestamped.filter(({ message, timestampMs }) => {
    const age_ms = options.nowMs - timestampMs;
    return age_ms >= 0 &&
      age_ms <= options.activityWindowMs &&
      bIsHumanMessage(message, options.botUserId);
  });

  if (recent_human_messages.length < min_human_messages) {
    return {
      shouldReply: false,
      reason: `only ${recent_human_messages.length} recent human message(s)`,
      contextMessages: [],
    };
  }

  const last_haru_message = [...timestamped]
    .reverse()
    .find(({ message }) => message.authorId === options.botUserId);

  if (last_haru_message) {
    const elapsed_ms = options.nowMs - last_haru_message.timestampMs;
    if (elapsed_ms >= 0 && elapsed_ms < options.cooldownMs) {
      return { shouldReply: false, reason: "cooldown active", contextMessages: [] };
    }

    const has_human_after_haru = timestamped.some(({ message, timestampMs }) =>
      timestampMs > last_haru_message.timestampMs &&
      bIsHumanMessage(message, options.botUserId)
    );

    if (!has_human_after_haru) {
      return {
        shouldReply: false,
        reason: "no human message after Haru",
        contextMessages: [],
      };
    }
  }

  if (options.replyChance <= 0) {
    return { shouldReply: false, reason: "reply chance disabled", contextMessages: [] };
  }

  if (options.random() > options.replyChance) {
    return { shouldReply: false, reason: "random gate skipped", contextMessages: [] };
  }

  const context_limit = Math.max(1, options.maxContextMessages);
  const context_messages = timestamped
    .slice(-context_limit)
    .map(({ message }) => oToAiContextMessage(message));

  return {
    shouldReply: true,
    reason: "active conversation eligible",
    contextMessages: context_messages,
  };
}
