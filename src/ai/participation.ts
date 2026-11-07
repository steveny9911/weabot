/** Autonomous participation: the structured output format and its fail-closed parser. */
import {
  DECISION_REASONS,
  type DecisionReason,
  isAllowedReaction,
  REACTION_INTENTS,
  type ReactionChoice,
  type ReactionIntent,
} from "../features/reactions.ts";
import type { AutonomousParticipation } from "./types.ts";

export const MAX_AUTONOMOUS_REPLY_CHARS = 280;

/** Deliberately small Unicode palette; custom/server emojis are not requested. */
export const AUTONOMOUS_REACTION_EMOJIS = ["😄", "😂", "🤣", "❤️", "👍", "🎉", "🐴"] as const;

export const AUTONOMOUS_PARTICIPATION_FORMAT = {
  type: "json_schema",
  name: "autonomous_participation",
  strict: true,
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["reply", "react", "silent"] },
      text: { type: "string" },
      messageId: { type: "string" },
      emoji: { type: "string" },
      intent: { type: "string", enum: ["", ...REACTION_INTENTS] },
      reason: { type: "string", enum: DECISION_REASONS },
    },
    required: ["action", "text", "messageId", "emoji", "intent", "reason"],
    additionalProperties: false,
  },
} as const;

/** Structured participation fails closed without generating substitute chatter. */
export function parseParticipation(
  text: string | null,
  allowedMessageIds: Set<string>,
  choices: ReactionChoice[],
): AutonomousParticipation {
  const silent: AutonomousParticipation = { action: "silent" };
  if (!text) return silent;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return silent;
    const choice = parsed as Record<string, unknown>;
    const keys = Object.keys(choice);
    if (
      keys.length !== 6 ||
      keys.some(
        (key) => !["action", "text", "messageId", "emoji", "intent", "reason"].includes(key),
      ) ||
      [
        choice.action,
        choice.text,
        choice.messageId,
        choice.emoji,
        choice.intent,
        choice.reason,
      ].some((value) => typeof value !== "string")
    )
      return silent;
    if (!DECISION_REASONS.some((reason) => reason === choice.reason)) return silent;
    if (
      choice.action === "reply" &&
      choice.messageId === "" &&
      choice.emoji === "" &&
      choice.intent === ""
    ) {
      const reply = (choice.text as string).trim();
      return reply && reply.length <= MAX_AUTONOMOUS_REPLY_CHARS
        ? { action: "reply", text: reply, reason: choice.reason as DecisionReason }
        : silent;
    }
    if (
      choice.action === "react" &&
      choice.text === "" &&
      allowedMessageIds.has(choice.messageId as string) &&
      isAllowedReaction(choice.emoji as string, choice.intent, choices)
    ) {
      if (
        (choice.reason === "unkindness" &&
          choice.intent !== "disapproval" &&
          choice.intent !== "concern") ||
        (choice.reason === "concern" && choice.intent !== "concern")
      )
        return silent;
      return {
        action: "react",
        messageId: choice.messageId as string,
        emoji: choice.emoji as string,
        intent: choice.intent as ReactionIntent,
        reason: choice.reason as DecisionReason,
      };
    }
    if (
      choice.action === "silent" &&
      choice.text === "" &&
      choice.messageId === "" &&
      choice.emoji === "" &&
      choice.intent === ""
    ) {
      return { action: "silent", reason: choice.reason as DecisionReason };
    }
    return silent;
  } catch {
    return silent;
  }
}
