/** Shared one-channel path for the production scheduler and explicit sandbox runs. */
import type { AiService, AutonomousParticipation } from "../../../ai_service.ts";
import type { AppConfig } from "../../config.ts";
import type { DiscordClient } from "../../services/discord.ts";
import type { StorageService } from "../../services/storage.ts";
import type { RateLimitService } from "../../services/rate_limit.ts";
import { AUTONOMOUS_CHAT_GUIDANCE, decideAutonomousChatReply } from "./mod.ts";
import {
  availableReactions,
  isAllowedReaction,
  reactionChoices,
  type ReactionContext,
} from "../reactions/mod.ts";

export interface ParticipationDeps {
  config: AppConfig;
  discord: DiscordClient;
  storage: StorageService;
  ai: AiService;
  rateLimit: RateLimitService;
  botId: string;
  now?: () => number;
  random?: () => number;
  deliver?: boolean;
}
export interface ParticipationOutcome {
  status: string;
  action?: AutonomousParticipation["action"];
  targetId?: string;
  emoji?: string;
}
export async function participateInChannel(
  channelId: string,
  deps: ParticipationDeps,
): Promise<ParticipationOutcome> {
  const { config, discord, storage, ai, rateLimit, botId } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const messages = await discord.getRecentMessages(
    channelId,
    config.autonomousChatMaxContextMessages,
  );
  const reset = await storage.getContextReset(channelId);
  const previous = await storage.getAutonomousParticipation(channelId);
  const options = {
    botUserId: botId,
    nowMs: now(),
    minHumanMessages: config.autonomousChatMinHumanMessages,
    activityWindowMs: config.autonomousChatActivityWindowMinutes * 60_000,
    inactivityGapMs: config.aiContextInactivityMinutes * 60_000,
    cooldownMs: config.autonomousChatCooldownMinutes * 60_000,
    maxContextMessages: config.autonomousChatMaxContextMessages,
    settleMs: (config.autonomousChatSettleSeconds ?? 0) * 1000,
    resetAfterMs: reset?.resetAt,
    replyChance: config.autonomousChatReplyChance,
    random,
    lastParticipation: previous,
  };
  const decision = decideAutonomousChatReply(messages, options);
  if (!decision.shouldReply || !decision.latestHumanMessage) {
    console.log(`[CRON] Autonomous chat skipped in ${channelId}: ${decision.reason}`);
    return { status: decision.reason };
  }
  const budget = await rateLimit.admitRequest("autonomous-chat", { enforceUserLimit: false });
  if (!budget.allowed) return { status: "daily budget exhausted" };
  const latest = decision.latestHumanMessage;
  const claimed = await storage.claimAutonomousParticipation({
    channelId,
    latestHumanMessageId: latest.id,
    latestHumanTimestampMs: Date.parse(latest.timestamp),
    attemptedAt: now(),
  }, options.cooldownMs);
  if (!claimed) return { status: "already claimed" };
  let usedEmoji: string | undefined;
  try {
    let context: ReactionContext | null = null;
    if (discord.getReactionContext) {
      try {
        context = await discord.getReactionContext(channelId, botId);
      } catch {
        return { status: "reaction metadata unavailable" };
      }
      if (context.channelId !== channelId) return { status: "reaction context mismatch" };
    }
    const choices = reactionChoices(context, previous?.lastReactionEmoji, random);
    const result = await ai.generateReply(decision.contextMessages, {
      mode: "autonomous",
      instructions: AUTONOMOUS_CHAT_GUIDANCE,
      allowedMessageIds: decision.reactionMessageIds ?? [],
      reactionChoices: choices,
    });
    if (result.tokensUsed) await rateLimit.recordTokenUsage(result.tokensUsed);
    if (!result.ok) return { status: "AI failed" };
    const p = result.participation;
    console.log(
      "[AUTONOMOUS DECISION]",
      JSON.stringify({
        channelId,
        watermark: latest.id,
        candidates: decision.reactionMessageIds?.slice(0, 100),
        action: p?.action ?? "silent",
        reason: p?.reason ?? "ambiguous",
        ...(p?.action === "react"
          ? { targetId: p.messageId, intent: p.intent, emoji: p.emoji }
          : {}),
      }),
    );
    if (!p || p.action === "silent") return { status: "silent", action: "silent" };
    if (p.action === "react") {
      const intent = p.intent ??
        (p.emoji === "🎉"
          ? "celebration"
          : p.emoji === "❤️" || p.emoji === "👍"
          ? "appreciation"
          : "amusement");
      if (
        !decision.reactionMessageIds?.includes(p.messageId) ||
        !isAllowedReaction(p.emoji, intent, choices)
      ) {
        return { status: "invalid reaction" };
      }
      const original = messages.find((m) => m.id === p.messageId)!;
      const freshMessages = await discord.getRecentMessages(
        channelId,
        config.autonomousChatMaxContextMessages,
      );
      const freshReset = await storage.getContextReset(channelId);
      const freshDecision = decideAutonomousChatReply(freshMessages, {
        ...options,
        resetAfterMs: freshReset?.resetAt,
        nowMs: now(),
        replyChance: 1,
        random: () => 0,
      });
      if (
        freshDecision.latestHumanMessage?.id !== latest.id ||
        !freshDecision.reactionMessageIds?.includes(p.messageId)
      ) {
        return { status: "conversation changed before delivery" };
      }
      const target = discord.getMessage
        ? await discord.getMessage(channelId, p.messageId)
        : freshMessages.find((m) => m.id === p.messageId);
      if (
        !target || target.authorId !== original.authorId || target.authorBot ||
        target.hasOwnReaction ||
        target.content !== original.content ||
        JSON.stringify(target.imageUrls) !== JSON.stringify(original.imageUrls)
      ) {
        return { status: "target changed before delivery" };
      }
      if (discord.getReactionContext) {
        const fresh = await discord.getReactionContext(channelId, botId);
        if (
          fresh.channelId !== channelId || fresh.guildId !== context?.guildId ||
          !isAllowedReaction(p.emoji, intent, availableReactions(fresh))
        ) {
          return { status: "expression unavailable before delivery" };
        }
      }
    }
    if (deps.deliver === false) {
      return {
        status: "dry-run",
        action: p.action,
        ...(p.action === "react" ? { targetId: p.messageId, emoji: p.emoji } : {}),
      };
    }
    let response: Response;
    try {
      response = p.action === "react"
        ? await discord.addReaction(channelId, p.messageId, p.emoji)
        : await discord.postMessage(channelId, {
          content: p.text,
          allowed_mentions: { parse: [] },
        });
    } catch {
      return { status: "delivery unconfirmed", action: p.action };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: `delivery HTTP ${response.status}`, action: p.action };
    }
    if (p.action === "react") usedEmoji = p.emoji;
    console.log(`[CRON] Autonomous ${p.action} succeeded in ${channelId}`);
    return {
      status: "delivered",
      action: p.action,
      ...(p.action === "react" ? { targetId: p.messageId, emoji: p.emoji } : {}),
    };
  } finally {
    await storage.finishAutonomousParticipation(channelId, latest.id, now(), usedEmoji);
  }
}
