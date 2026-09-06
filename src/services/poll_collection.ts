/** Shared scheduled/manual collection. Failures remain pending for the next run. */
import type { Mood } from "../types/bot.ts";
import type { PollRecord } from "../types/storage.ts";
import type { DiscordClient, PollVoter } from "./discord.ts";
import type { StorageService } from "./storage.ts";

export interface PollCollectionResult {
  collected: { poll: PollRecord; votes: number }[];
  failed: { poll: PollRecord; error: unknown }[];
}

export async function collectExpiredPolls(
  discord: DiscordClient,
  storage: StorageService,
): Promise<PollCollectionResult> {
  const result: PollCollectionResult = { collected: [], failed: [] };
  for (const poll of await storage.getExpiredPolls()) {
    try {
      // Fetch and validate every answer before writing any vote.
      const answers = await discord.getPollVoters(poll.channelId, poll.messageId);
      const moods = new Set<Mood>();
      const voters = new Set<string>();
      const votes = answers.flatMap<PollVoter & { mood: Mood }>((answer) => {
        const mood = answer.answerText.toLowerCase();
        if (mood !== "umazing" && mood !== "ok" && mood !== "glue") {
          throw new Error(`Unknown mood answer ${answer.answerId}: ${answer.answerText}`);
        }
        if (moods.has(mood)) throw new Error(`Duplicate mood answer: ${mood}`);
        moods.add(mood);
        return answer.voters.map((voter) => {
          if (voters.has(voter.odUserId)) throw new Error(`Duplicate voter: ${voter.odUserId}`);
          voters.add(voter.odUserId);
          return { ...voter, mood };
        });
      });
      if (moods.size !== 3) throw new Error("Incomplete mood poll answers");

      for (const vote of votes) {
        // Storage upserts by channel/date/user, so retries repair partial persistence.
        await storage.recordVote(
          poll.channelId,
          vote.odUserId,
          vote.odUserName,
          vote.mood,
          poll.date,
        );
      }
      await storage.markPollCollected(poll.messageId);
      result.collected.push({ poll, votes: votes.length });
      console.log(`[POLL] Collected ${votes.length} vote(s) from poll ${poll.messageId}`);
    } catch (error) {
      result.failed.push({ poll, error });
      console.error(
        `[POLL] Collection failed for poll ${poll.messageId} in channel ${poll.channelId}; will retry:`,
        error,
      );
    }
  }
  return result;
}
