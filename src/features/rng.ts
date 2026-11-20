/** The \rng command: one random number per user per day, revealed a digit at a time. */
import type { RngQueries } from "../db/rng.ts";

export interface RngService {
  /**
   * The user's number for today: drawn now (`fresh`) or the one they already drew. Null while the
   * user's previous request is still being answered, so that one is not interrupted. Every
   * non-null draw must be followed by `finish`.
   */
  draw(userId: string): { number: string; fresh: boolean } | null;
  /** The user's request has been answered, so they may ask again. */
  finish(userId: string): void;
}

export interface RngDependencies {
  queries: RngQueries;
  /** How many digits a number has. */
  digits: number;
  /** The zone whose midnight starts a new day. */
  timeZone: string;
  now?: () => number;
}

/** A number of `digits` digits that never starts with 0. */
function randomNumber(digits: number): string {
  const digit = (min: number) => min + Math.floor(Math.random() * (10 - min));
  return digit(1) + Array.from({ length: digits - 1 }, () => digit(0)).join("");
}

export function createRngService(deps: RngDependencies): RngService {
  const { queries, digits, timeZone, now = Date.now } = deps;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone });
  const answering = new Set<string>();

  return {
    // Synchronous, so two messages from one user cannot both draw.
    draw(userId) {
      if (answering.has(userId)) return null;
      const date = day.format(now());
      const saved = queries.get(userId);
      const result =
        saved?.date === date
          ? { number: saved.number, fresh: false }
          : { number: randomNumber(digits), fresh: true };
      if (result.fresh) queries.save(userId, date, result.number);
      // Only now, so a failed query cannot leave the user stuck.
      answering.add(userId);
      return result;
    },
    finish: (userId) => void answering.delete(userId),
  };
}

/** The whole number, as shown to a user who already drew today and at the end of a reveal. */
export const formatNumber = (number: string) => `🎲**${number}**`;

/** What a reveal shows: 🎲1....., 🎲13...., and so on, ending with the whole number. */
export function revealFrames(number: string): string[] {
  const partial = Array.from(
    { length: number.length - 1 },
    (_, i) => `🎲${number.slice(0, i + 1)}${".".repeat(number.length - i - 1)}`,
  );
  return [...partial, formatNumber(number)];
}
