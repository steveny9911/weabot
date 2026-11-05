/** Context resets and autonomous participation. */
import type { Database } from "bun:sqlite";
import {
  type AutonomousParticipationRecord,
  type ContextResetRecord,
  isNewerHumanMessage,
} from "../types/storage.ts";

interface ParticipationRow {
  channel_id: string;
  latest_human_message_id: string;
  latest_human_timestamp_ms: number;
  attempted_at: number;
  last_reaction_emoji: string | null;
}

const toParticipation = (row: ParticipationRow): AutonomousParticipationRecord => ({
  channelId: row.channel_id,
  latestHumanMessageId: row.latest_human_message_id,
  attemptedAt: row.attempted_at,
  latestHumanTimestampMs: row.latest_human_timestamp_ms,
  ...(row.last_reaction_emoji ? { lastReactionEmoji: row.last_reaction_emoji } : {}),
});

export function createChatStateQueries(db: Database) {
  const upsertReset = db.query(
    `INSERT INTO context_resets (channel_id, message_id, reset_at)
     VALUES ($channelId, $messageId, $resetAt)
     ON CONFLICT (channel_id) DO UPDATE SET
       message_id = excluded.message_id, reset_at = excluded.reset_at`,
  );
  const getReset = db.query<
    { channel_id: string; message_id: string; reset_at: number },
    { channel: string }
  >(`SELECT * FROM context_resets WHERE channel_id = $channel`);
  const getParticipation = db.query<ParticipationRow, { channel: string }>(
    `SELECT * FROM autonomous_participation WHERE channel_id = $channel`,
  );
  const upsertParticipation = db.query(
    `INSERT INTO autonomous_participation (channel_id, latest_human_message_id,
       latest_human_timestamp_ms, attempted_at, last_reaction_emoji)
     VALUES ($channel, $message, $timestamp, $attemptedAt, $emoji)
     ON CONFLICT (channel_id) DO UPDATE SET
       latest_human_message_id = excluded.latest_human_message_id,
       latest_human_timestamp_ms = excluded.latest_human_timestamp_ms,
       attempted_at = excluded.attempted_at,
       last_reaction_emoji = excluded.last_reaction_emoji`,
  );

  function readParticipation(channel: string): AutonomousParticipationRecord | null {
    const row = getParticipation.get({ channel });
    return row ? toParticipation(row) : null;
  }
  function writeParticipation(record: AutonomousParticipationRecord): void {
    upsertParticipation.run({
      channel: record.channelId,
      message: record.latestHumanMessageId,
      timestamp: record.latestHumanTimestampMs,
      attemptedAt: record.attemptedAt,
      emoji: record.lastReactionEmoji ?? null,
    });
  }

  /** Consumes a newer human message and the channel cooldown in one transaction. */
  const claim = db.transaction(
    (record: AutonomousParticipationRecord, cooldownMs: number): boolean => {
      const previous = readParticipation(record.channelId);
      if (
        previous &&
        (!isNewerHumanMessage(record, previous) ||
          record.attemptedAt - previous.attemptedAt < cooldownMs)
      )
        return false;
      writeParticipation({
        ...record,
        lastReactionEmoji: record.lastReactionEmoji || previous?.lastReactionEmoji,
      });
      return true;
    },
  );

  /** Extends the cooldown from completion, unless a newer message has been claimed. */
  const finish = db.transaction(
    (channel: string, messageId: string, finishedAt: number, emoji?: string): void => {
      const previous = readParticipation(channel);
      if (!previous || previous.latestHumanMessageId !== messageId) return;
      const attemptedAt = Math.max(previous.attemptedAt, finishedAt);
      if (attemptedAt === previous.attemptedAt && (!emoji || emoji === previous.lastReactionEmoji))
        return;
      writeParticipation({
        ...previous,
        attemptedAt,
        ...(emoji ? { lastReactionEmoji: emoji } : {}),
      });
    },
  );

  return {
    setContextReset(record: ContextResetRecord): void {
      upsertReset.run({ ...record });
    },
    getContextReset(channel: string): ContextResetRecord | null {
      const row = getReset.get({ channel });
      return row
        ? { channelId: row.channel_id, messageId: row.message_id, resetAt: row.reset_at }
        : null;
    },
    getParticipation: readParticipation,
    claimParticipation(record: AutonomousParticipationRecord, cooldownMs: number): boolean {
      return claim.immediate(record, cooldownMs);
    },
    finishParticipation(channel: string, messageId: string, at: number, emoji?: string): void {
      finish.immediate(channel, messageId, at, emoji);
    },
  };
}
