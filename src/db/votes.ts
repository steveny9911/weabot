/** Votes and polls. */
import type { Database } from "bun:sqlite";
import type { Mood } from "../types/bot.ts";
import type { PollRecord, VoteRecord } from "../types/storage.ts";

interface VoteRow {
  channel_id: string;
  vote_date: string;
  user_id: string;
  user_name: string;
  mood: Mood;
  recorded_at: number;
}

interface PollRow {
  message_id: string;
  channel_id: string;
  poll_date: string;
  created_at: number;
  expires_at: number;
  collected_at: number | null;
}

const toVote = (row: VoteRow): VoteRecord => ({
  channelId: row.channel_id,
  userId: row.user_id,
  userName: row.user_name,
  mood: row.mood,
  date: row.vote_date,
  timestamp: row.recorded_at,
});

const toPoll = (row: PollRow): PollRecord => ({
  messageId: row.message_id,
  channelId: row.channel_id,
  date: row.poll_date,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  collected: row.collected_at !== null,
});

export function createVoteQueries(db: Database) {
  const upsertVote = db.query(
    `INSERT INTO votes (channel_id, vote_date, user_id, user_name, mood, recorded_at)
     VALUES ($channel, $date, $user, $name, $mood, $at)
     ON CONFLICT (channel_id, vote_date, user_id)
     DO UPDATE SET user_name = excluded.user_name, mood = excluded.mood,
                   recorded_at = excluded.recorded_at`,
  );
  const userHistory = db.query<VoteRow, { channel: string; user: string; limit: number }>(
    `SELECT * FROM votes WHERE channel_id = $channel AND user_id = $user
     ORDER BY vote_date DESC LIMIT $limit`,
  );
  const votesForDate = db.query<VoteRow, { channel: string; date: string }>(
    `SELECT * FROM votes WHERE channel_id = $channel AND vote_date = $date ORDER BY user_id`,
  );
  const moodCounts = db.query<
    { vote_date: string; mood: Mood; count: number },
    { channel: string; start: string; end: string }
  >(
    `SELECT vote_date, mood, COUNT(*) AS count FROM votes
     WHERE channel_id = $channel AND vote_date BETWEEN $start AND $end
     GROUP BY vote_date, mood`,
  );
  const voters = db.query<{ user_id: string }, { channel: string }>(
    `SELECT DISTINCT user_id FROM votes WHERE channel_id = $channel ORDER BY user_id`,
  );
  const upsertPoll = db.query(
    `INSERT INTO polls (message_id, channel_id, poll_date, created_at, expires_at, collected_at)
     VALUES ($messageId, $channelId, $date, $createdAt, $expiresAt, $collectedAt)
     ON CONFLICT (message_id) DO UPDATE SET
       channel_id = excluded.channel_id, poll_date = excluded.poll_date,
       created_at = excluded.created_at, expires_at = excluded.expires_at,
       collected_at = excluded.collected_at`,
  );
  const uncollectedPolls = db.query<PollRow, { now: number }>(
    `SELECT * FROM polls WHERE collected_at IS NULL AND expires_at <= $now ORDER BY message_id`,
  );
  const allUncollectedPolls = db.query<PollRow, []>(
    `SELECT * FROM polls WHERE collected_at IS NULL ORDER BY message_id`,
  );
  const collectPoll = db.query(`UPDATE polls SET collected_at = $at WHERE message_id = $messageId`);

  return {
    recordVote(vote: VoteRecord): void {
      upsertVote.run({
        channel: vote.channelId,
        date: vote.date,
        user: vote.userId,
        name: vote.userName,
        mood: vote.mood,
        at: vote.timestamp,
      });
    },
    userHistory(channel: string, user: string, limit: number): VoteRecord[] {
      return userHistory.all({ channel, user, limit }).map(toVote);
    },
    votesForDate(channel: string, date: string): VoteRecord[] {
      return votesForDate.all({ channel, date }).map(toVote);
    },
    moodCounts(channel: string, start: string, end: string) {
      return moodCounts.all({ channel, start, end });
    },
    voters(channel: string): string[] {
      return voters.all({ channel }).map((row) => row.user_id);
    },
    savePoll(poll: PollRecord, now: number): void {
      upsertPoll.run({
        messageId: poll.messageId,
        channelId: poll.channelId,
        date: poll.date,
        createdAt: poll.createdAt,
        expiresAt: poll.expiresAt,
        collectedAt: poll.collected ? now : null,
      });
    },
    expiredPolls(now: number): PollRecord[] {
      return uncollectedPolls.all({ now }).map(toPoll);
    },
    pendingPolls(): PollRecord[] {
      return allUncollectedPolls.all().map(toPoll);
    },
    /** Returns whether a poll was updated. */
    markCollected(messageId: string, at: number): boolean {
      return collectPoll.run({ messageId, at }).changes > 0;
    },
  };
}
