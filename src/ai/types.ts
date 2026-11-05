/** Public types of the AI service: results, per-request options and the service interface. */
import type { DecisionReason, ReactionChoice, ReactionIntent } from "../features/reactions.ts";

export type AutonomousParticipation =
  | { action: "reply"; text: string; reason?: DecisionReason }
  | {
      action: "react";
      messageId: string;
      emoji: string;
      intent?: ReactionIntent;
      reason?: DecisionReason;
    }
  | { action: "silent"; reason?: DecisionReason };

/** Successful AI response with token usage */
export interface AiSuccessResult {
  ok: true;
  text: string;
  tokensUsed: number;
  /** Present only for autonomous participation; reactions and silence have empty text. */
  participation?: AutonomousParticipation;
}

/** Failed AI response */
export interface AiErrorResult {
  ok: false;
  error: string;
  /** Tokens reported before an action or autonomous request failed. */
  tokensUsed?: number;
}

export type AiResult = AiSuccessResult | AiErrorResult;

/** Action capabilities scoped to one explicitly requested reply. */
export interface AiReplyOptions {
  instructions: string;
  /** Latest human request, separate from untrusted conversation/reference context. */
  currentUserMessage?: string;
  tools: Array<Record<string, unknown>>;
  executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Autonomous participation has no action tools or implicit human request. */
export interface AiParticipationOptions {
  mode: "autonomous";
  instructions: string;
  /** Recent human message IDs that may receive one reaction. */
  allowedMessageIds: string[];
  reactionChoices?: ReactionChoice[];
}

/** AI service interface for dependency injection */
export interface AiService {
  /** Generate a reply from conversation messages */
  generateReply(
    messages: Array<Record<string, unknown>>,
    options?: AiReplyOptions | AiParticipationOptions,
  ): Promise<AiResult>;
}
